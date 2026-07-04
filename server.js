import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Configuration
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  port: 3000,
  lmStudioUrl: 'http://127.0.0.1:1234',
  bridgeApiKey: 'rimmind-bridge',   // key RimMind sends; set in RimWorld mod settings
  lmStudioApiKey: '',               // optional; only needed if LM Studio has auth enabled
  autoMapModel: true,
  sanitizeResponse: true,
  timeoutMs: 120000, // 2 minutes
  queueConcurrency: 1
};

// Load existing config if available
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = { ...config, ...JSON.parse(data) };
  } catch (err) {
    console.error('Error reading config file, using defaults:', err);
  }
}

// Save configuration helper
const saveConfig = () => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving config file:', err);
    return false;
  }
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware for /v1/* routes — validates Bearer token from RimMind
const validateBridgeAuth = (req, res, next) => {
  // If no bridgeApiKey is configured, skip auth
  if (!config.bridgeApiKey) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    logToDashboard('warn', 'proxy', `Rejected unauthenticated ${req.method} ${req.path}`);
    return res.status(401).json({ error: { message: 'Missing Authorization header. Set your API key in RimMind-Core settings.', type: 'auth_error', code: 'missing_key' } });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== config.bridgeApiKey) {
    logToDashboard('warn', 'proxy', `Rejected invalid API key on ${req.method} ${req.path}`);
    return res.status(401).json({ error: { message: 'Invalid API key.', type: 'auth_error', code: 'invalid_key' } });
  }

  next();
};

// Apply auth to all OpenAI-compatible proxy routes
app.use('/v1', validateBridgeAuth);

// In-Memory Request Queue and Logger
const logBuffer = [];
const activeRequests = new Map();
const queue = [];
let processingQueue = false;

// SSE Client Connections
let sseClients = [];

// Log helper
const logToDashboard = (level, type, message, details = null) => {
  const logEntry = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toISOString(),
    level, // 'info', 'warn', 'error', 'success'
    type,  // 'server', 'proxy', 'queue', 'lm-studio'
    message,
    details
  };
  
  logBuffer.push(logEntry);
  if (logBuffer.length > 100) logBuffer.shift();
  
  // Stream to all connected SSE clients
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });
  
  console.log(`[${logEntry.timestamp}] [${level.toUpperCase()}] [${type}] ${message}`);
};

// Queue class / worker
const processQueue = async () => {
  if (processingQueue || queue.length === 0) return;
  processingQueue = true;
  
  logToDashboard('info', 'queue', `Starting queue processing. Queue length: ${queue.length}`);
  
  while (queue.length > 0) {
    const task = queue.shift();
    logToDashboard('info', 'queue', `Processing request in queue. Remaining: ${queue.length}`);
    
    try {
      await task();
    } catch (err) {
      logToDashboard('error', 'queue', `Error during task execution: ${err.message}`);
    }
  }
  
  processingQueue = false;
  logToDashboard('info', 'queue', 'Queue is now empty.');
};

// Helper: Clean Markdown wrappers from content
const sanitizeMessageContent = (content) => {
  if (!content || typeof content !== 'string') return content;
  
  let cleaned = content.trim();
  
  // Regex to match ```json <content> ``` or just ``` <content> ```
  const mdJsonRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = cleaned.match(mdJsonRegex);
  
  if (match && match[1]) {
    logToDashboard('success', 'proxy', 'Successfully cleaned markdown code blocks from LLM output.');
    return match[1].trim();
  }
  
  return cleaned;
};

// Helper: Check connectivity to LM Studio and fetch loaded models
// Sends auth only if lmStudioApiKey is configured (for setups with auth enabled)
const fetchLMStudioModels = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const headers = {};
    if (config.lmStudioApiKey) {
      headers['Authorization'] = `Bearer ${config.lmStudioApiKey}`;
    }
    
    const response = await fetch(`${config.lmStudioUrl}/v1/models`, {
      signal: controller.signal,
      headers
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    
    const data = await response.json();
    return { online: true, models: data.data || [] };
  } catch (err) {
    return { online: false, error: err.message, models: [] };
  }
};

// Helper: Get RimWorld local config directory
const getRimWorldConfigPath = () => {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (!userProfile) return null;
  return path.join(userProfile, 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config');
};

// Helper: Find Mod XML config file in local appdata folder
const findRimMindConfigFile = () => {
  const configDir = getRimWorldConfigPath();
  if (!configDir || !fs.existsSync(configDir)) return null;
  
  try {
    const files = fs.readdirSync(configDir);
    const rimMindFile = files.find(f => f.startsWith('Mod_') && f.endsWith('_RimMindCoreMod.xml'));
    return rimMindFile ? path.join(configDir, rimMindFile) : null;
  } catch (err) {
    console.error('Error scanning RimWorld config directory:', err);
    return null;
  }
};

// Helper: Read settings from local RimMind configuration XML
const readRimMindConfig = () => {
  const filePath = findRimMindConfigFile();
  if (!filePath || !fs.existsSync(filePath)) {
    return { found: false, searchPath: getRimWorldConfigPath() };
  }
  
  try {
    const xml = fs.readFileSync(filePath, 'utf8');
    
    const apiKeyMatch = xml.match(/<apiKey>([\s\S]*?)<\/apiKey>/);
    const apiEndpointMatch = xml.match(/<apiEndpoint>([\s\S]*?)<\/apiEndpoint>/);
    const modelNameMatch = xml.match(/<modelName>([\s\S]*?)<\/modelName>/);
    
    return {
      found: true,
      filePath,
      fileName: path.basename(filePath),
      apiKey: apiKeyMatch ? apiKeyMatch[1].trim() : '',
      apiEndpoint: apiEndpointMatch ? apiEndpointMatch[1].trim() : '',
      modelName: modelNameMatch ? modelNameMatch[1].trim() : ''
    };
  } catch (err) {
    return { found: false, searchPath: getRimWorldConfigPath(), error: err.message };
  }
};

// Helper: Update settings in local RimMind configuration XML
const updateRimMindConfig = (endpoint, apiKey) => {
  const filePath = findRimMindConfigFile();
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, message: 'RimMind config XML file not found.' };
  }
  
  try {
    let xml = fs.readFileSync(filePath, 'utf8');
    
    // Replace or insert apiKey element
    if (xml.includes('<apiKey>')) {
      xml = xml.replace(/<apiKey>([\s\S]*?)<\/apiKey>/, `<apiKey>${apiKey}</apiKey>`);
    } else {
      xml = xml.replace('</ModSettings>', `\t<apiKey>${apiKey}</apiKey>\n\t</ModSettings>`);
    }
    
    // Replace or insert apiEndpoint element
    if (xml.includes('<apiEndpoint>')) {
      xml = xml.replace(/<apiEndpoint>([\s\S]*?)<\/apiEndpoint>/, `<apiEndpoint>${endpoint}</apiEndpoint>`);
    } else {
      xml = xml.replace('</ModSettings>', `\t<apiEndpoint>${endpoint}</apiEndpoint>\n\t</ModSettings>`);
    }
    
    fs.writeFileSync(filePath, xml, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

// Integration API: Get RimWorld settings link status
app.get('/api/rimworld-config', (req, res) => {
  res.json(readRimMindConfig());
});

// Integration API: Link/Configure RimWorld mod settings file directly
app.post('/api/rimworld-config', (req, res) => {
  const endpoint = `https://localhost:${config.port}/v1`;
  const apiKey = config.bridgeApiKey || 'rimmind-bridge';
  
  const result = updateRimMindConfig(endpoint, apiKey);
  if (result.success) {
    logToDashboard('success', 'server', `Successfully auto-configured RimWorld settings file: ${path.basename(findRimMindConfigFile())}`);
    res.json({ success: true, config: readRimMindConfig() });
  } else {
    logToDashboard('error', 'server', `Failed to update RimWorld settings: ${result.message}`);
    res.status(500).json({ success: false, message: result.message });
  }
});

// SSE Endpoint for Live Logs
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  // Send existing history
  res.write(`data: ${JSON.stringify({ type: 'history', logs: logBuffer })}\n\n`);
  
  sseClients.push(res);
  
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Admin API: Get Status
app.get('/api/status', async (req, res) => {
  const lmStatus = await fetchLMStudioModels();
  
  res.json({
    config,
    queueSize: queue.length,
    processingQueue,
    lmStudio: {
      url: config.lmStudioUrl,
      online: lmStatus.online,
      error: lmStatus.error || null,
      models: lmStatus.models.map(m => m.id)
    }
  });
});

// Admin API: Update Config
app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  
  if (newConfig.port !== undefined) config.port = parseInt(newConfig.port);
  if (newConfig.lmStudioUrl !== undefined) config.lmStudioUrl = newConfig.lmStudioUrl;
  if (newConfig.bridgeApiKey !== undefined) config.bridgeApiKey = newConfig.bridgeApiKey;
  if (newConfig.lmStudioApiKey !== undefined) config.lmStudioApiKey = newConfig.lmStudioApiKey;
  if (newConfig.autoMapModel !== undefined) config.autoMapModel = !!newConfig.autoMapModel;
  if (newConfig.sanitizeResponse !== undefined) config.sanitizeResponse = !!newConfig.sanitizeResponse;
  if (newConfig.timeoutMs !== undefined) config.timeoutMs = parseInt(newConfig.timeoutMs);
  
  if (saveConfig()) {
    logToDashboard('success', 'server', 'Configuration updated successfully.');
    res.json({ success: true, config });
  } else {
    res.status(500).json({ success: false, message: 'Failed to write config file.' });
  }
});

// Admin API: Test connection
app.post('/api/test-connection', async (req, res) => {
  const lmStatus = await fetchLMStudioModels();
  res.json(lmStatus);
});

// OpenAI proxy routes

// 1. Models List
app.get('/v1/models', async (req, res) => {
  logToDashboard('info', 'proxy', 'Received model list request from RimWorld/client.');
  const lmStatus = await fetchLMStudioModels();
  
  if (lmStatus.online) {
    res.json({ object: 'list', data: lmStatus.models });
  } else {
    logToDashboard('warn', 'proxy', 'LM Studio is offline. Returning fallback model list.');
    // Return a fallback model so RimMind's test connection doesn't break
    res.json({
      object: 'list',
      data: [
        { id: 'lm-studio-offline-fallback', object: 'model', owned_by: 'lm-studio' }
      ]
    });
  }
});

// 2. Chat Completions
app.post('/v1/chat/completions', (req, res) => {
  const requestId = 'req-' + Math.random().toString(36).substr(2, 9);
  const startTimestamp = Date.now();
  const body = req.body;
  
  const requestedModel = body.model;
  const promptSummary = body.messages && body.messages.length > 0 
    ? body.messages[body.messages.length - 1].content 
    : 'No messages';
  
  logToDashboard('info', 'proxy', `Received chat request [${requestId}] for model "${requestedModel}". Queueing...`, {
    requestId,
    model: requestedModel,
    promptSummary: promptSummary.substr(0, 100) + (promptSummary.length > 100 ? '...' : '')
  });
  
  // Wrap completion logic in a queued function
  const executeRequest = () => {
    return new Promise(async (resolve) => {
      activeRequests.set(requestId, { startTimestamp, body });
      logToDashboard('info', 'queue', `Executing request [${requestId}] now...`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        logToDashboard('error', 'queue', `Request [${requestId}] timed out after ${config.timeoutMs}ms.`);
        controller.abort();
      }, config.timeoutMs);
      
      try {
        // Auto Map Model Name if active
        let targetModel = requestedModel;
        if (config.autoMapModel) {
          const lmStatus = await fetchLMStudioModels();
          if (lmStatus.online && lmStatus.models.length > 0) {
            // Find active model. LM Studio usually has 1 model loaded, or we just map to the first available loaded model.
            const activeModel = lmStatus.models[0].id;
            if (activeModel && activeModel !== requestedModel) {
              logToDashboard('info', 'proxy', `Auto-mapping requested model "${requestedModel}" to active LM Studio model "${activeModel}".`);
              body.model = activeModel;
              targetModel = activeModel;
            }
          }
        }
        
        logToDashboard('info', 'lm-studio', `Forwarding request [${requestId}] to LM Studio: ${config.lmStudioUrl}/v1/chat/completions`);
        
        // Forward to LM Studio — include auth only if lmStudioApiKey is set
        const proxyHeaders = { 'Content-Type': 'application/json' };
        if (config.lmStudioApiKey) {
          proxyHeaders['Authorization'] = `Bearer ${config.lmStudioApiKey}`;
        }
        
        const response = await fetch(`${config.lmStudioUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: proxyHeaders,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`LM Studio returned ${response.status}: ${text}`);
        }
        
        const responseData = await response.json();
        const duration = Date.now() - startTimestamp;
        
        // Clean up markdown in response content if configured
        if (config.sanitizeResponse && responseData.choices && responseData.choices[0] && responseData.choices[0].message) {
          const originalContent = responseData.choices[0].message.content;
          const cleanedContent = sanitizeMessageContent(originalContent);
          responseData.choices[0].message.content = cleanedContent;
        }
        
        const promptTokens = responseData.usage ? responseData.usage.prompt_tokens : 0;
        const completionTokens = responseData.usage ? responseData.usage.completion_tokens : 0;
        
        logToDashboard('success', 'proxy', `Request [${requestId}] completed in ${duration}ms. Tokens: Prompt=${promptTokens}, Completion=${completionTokens}`, {
          requestId,
          durationMs: duration,
          model: targetModel,
          promptTokens,
          completionTokens,
          response: responseData.choices && responseData.choices[0] && responseData.choices[0].message 
            ? responseData.choices[0].message.content.substr(0, 150) + '...'
            : 'No response text'
        });
        
        res.json(responseData);
      } catch (err) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTimestamp;
        logToDashboard('error', 'proxy', `Request [${requestId}] failed in ${duration}ms: ${err.message}`);
        
        res.status(500).json({
          error: {
            message: `RimMind Bridge Error: ${err.message}`,
            type: 'bridge_error',
            param: null,
            code: 'internal_error'
          }
        });
      } finally {
        activeRequests.delete(requestId);
        resolve();
      }
    });
  };
  
  // Push to queue
  queue.push(executeRequest);
  
  // Trigger processing
  processQueue();
});

// Fallback error handler
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.status(500).json({ error: { message: err.message } });
});

// Start Server — HTTPS if certificate.pfx exists, otherwise HTTP fallback
const PFX_PATH = path.join(__dirname, 'certificate.pfx');
const PFX_PASS = 'rimmind-bridge';

if (fs.existsSync(PFX_PATH)) {
  const pfx = fs.readFileSync(PFX_PATH);
  const httpsServer = https.createServer({ pfx, passphrase: PFX_PASS }, app);
  httpsServer.listen(config.port, () => {
    logToDashboard('success', 'server', `RimMind LM Studio Bridge started on HTTPS port ${config.port}`);
    logToDashboard('info', 'server', `Dashboard: https://localhost:${config.port}`);
    logToDashboard('info', 'server', `Set RimWorld endpoint to: https://localhost:${config.port}/v1`);
    logToDashboard('info', 'server', `Target LM Studio URL: ${config.lmStudioUrl}`);
  });
} else {
  logToDashboard('warn', 'server', 'certificate.pfx not found — starting in plain HTTP mode.');
  logToDashboard('info', 'server', 'Run "npm run setup-certs" to generate a trusted certificate.');
  const httpServer = app.listen(config.port, () => {
    logToDashboard('success', 'server', `RimMind LM Studio Bridge started on HTTP port ${config.port}`);
    logToDashboard('info', 'server', `Dashboard: http://localhost:${config.port}`);
    logToDashboard('info', 'server', `Set RimWorld endpoint to: http://localhost:${config.port}/v1`);
    logToDashboard('info', 'server', `Target LM Studio URL: ${config.lmStudioUrl}`);
  });
}
