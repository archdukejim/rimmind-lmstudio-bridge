// UI Elements
const elBridgePort = document.getElementById('lbl-bridge-port');
const elLmStatusPill = document.getElementById('pill-lm-status');
const elLmStatusText = document.getElementById('lbl-lm-status');
const elQueueSize = document.getElementById('lbl-queue-size');
const elQueueProcessor = document.getElementById('lbl-queue-processor');
const elProgressQueue = document.getElementById('progress-queue');
const elModelsList = document.getElementById('models-list');
const elLogsContainer = document.getElementById('logs-container');
const elBtnClearLogs = document.getElementById('btn-clear-logs');
const elBtnRefreshModels = document.getElementById('btn-refresh-models');

const elConfigForm = document.getElementById('config-form');
const elInputPort = document.getElementById('input-port');
const elInputUrl = document.getElementById('input-url');
const elInputBridgeKey = document.getElementById('input-bridge-key');
const elInputLmKey = document.getElementById('input-lm-key');
const elChkAutoMap = document.getElementById('chk-auto-map');
const elChkSanitize = document.getElementById('chk-sanitize');

// Playground Elements
const elTxtPlaygroundPrompt = document.getElementById('txt-playground-prompt');
const elBtnTestPing = document.getElementById('btn-test-ping');
const elBtnSubmitTest = document.getElementById('btn-submit-test');
const elSpinnerTest = document.getElementById('spinner-test');
const elPlaygroundResultBox = document.getElementById('playground-result-box');
const elPlaygroundOutput = document.getElementById('playground-output');

// Modal Elements
const elModalOverlay = document.getElementById('log-detail-modal');
const elBtnCloseModal = document.getElementById('btn-close-modal');
const elDetailTime = document.getElementById('detail-time');
const elDetailType = document.getElementById('detail-type');
const elDetailDuration = document.getElementById('detail-duration');
const elDetailTokens = document.getElementById('detail-tokens');
const elDetailCode = document.getElementById('detail-code');

// Logs state map to easily retrieve log details on click
const logsMap = new Map();

// Initialize UI Config Form
let initializedConfig = false;

// 1. Fetch Current Status
async function updateStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Failed to fetch status');
    const data = await response.json();
    
    // Update labels
    elBridgePort.textContent = data.config.port;
    
    // Update LM Studio Online Pill
    if (data.lmStudio.online) {
      elLmStatusPill.className = 'status-pill status-lm-online';
      elLmStatusText.textContent = 'ONLINE';
    } else {
      elLmStatusPill.className = 'status-pill status-lm-offline';
      elLmStatusText.textContent = 'OFFLINE';
    }
    
    // Update Queue
    elQueueSize.textContent = data.queueSize;
    if (data.processingQueue) {
      elQueueProcessor.textContent = 'Active';
      elQueueProcessor.className = 'value status-active';
      elProgressQueue.style.width = '100%';
    } else {
      elQueueProcessor.textContent = 'Idle';
      elQueueProcessor.className = 'value status-inactive';
      elProgressQueue.style.width = data.queueSize > 0 ? '50%' : '0%';
    }
    
    // Update Models list
    renderModels(data.lmStudio.models);
    
    // Initial config load to populate form inputs
    if (!initializedConfig) {
      elInputPort.value = data.config.port;
      elInputUrl.value = data.config.lmStudioUrl;
      elInputBridgeKey.value = data.config.bridgeApiKey || '';
      elInputLmKey.value = data.config.lmStudioApiKey || '';
      elChkAutoMap.checked = data.config.autoMapModel;
      elChkSanitize.checked = data.config.sanitizeResponse;
      initializedConfig = true;
    }
  } catch (err) {
    console.error('Error fetching bridge status:', err);
  }
}

// Render active models list
function renderModels(models) {
  if (!models || models.length === 0) {
    elModelsList.innerHTML = `<div class="empty-state">No models loaded. Load one in LM Studio.</div>`;
    return;
  }
  
  elModelsList.innerHTML = models.map(model => `
    <div class="model-item" title="${model}">
      <span class="model-badge"></span>
      <span class="model-name">${model}</span>
    </div>
  `).join('');
}

// 2. Stream logs using SSE
function initializeSSE() {
  const eventSource = new EventSource('/api/logs');
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'history') {
        elLogsContainer.innerHTML = '';
        data.logs.forEach(log => appendLog(log));
      } else {
        // Remove placeholder if present
        const placeholder = elLogsContainer.querySelector('.log-placeholder');
        if (placeholder) placeholder.remove();
        
        appendLog(data);
      }
    } catch (err) {
      console.error('Error parsing SSE event:', err);
    }
  };
  
  eventSource.onerror = () => {
    console.warn('SSE connection lost. Reconnecting...');
    eventSource.close();
    setTimeout(initializeSSE, 3000);
  };
}

function appendLog(log) {
  // Store log in map
  logsMap.set(log.id, log);
  
  const logItem = document.createElement('div');
  logItem.className = `log-item log-${log.level}`;
  logItem.dataset.id = log.id;
  
  const timeStr = new Date(log.timestamp).toLocaleTimeString();
  
  logItem.innerHTML = `
    <div class="log-header">
      <div class="log-meta">
        <span class="log-time">${timeStr}</span>
        <span class="log-type">${log.type}</span>
      </div>
      <span class="log-chevron">🛈</span>
    </div>
    <div class="log-msg">${escapeHtml(log.message)}</div>
  `;
  
  logItem.addEventListener('click', () => showLogDetails(log.id));
  
  elLogsContainer.appendChild(logItem);
  elLogsContainer.scrollTop = elLogsContainer.scrollHeight;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Show Log Details in Modal
function showLogDetails(id) {
  const log = logsMap.get(id);
  if (!log) return;
  
  elDetailTime.textContent = new Date(log.timestamp).toLocaleString();
  elDetailType.textContent = log.type.toUpperCase();
  elDetailType.className = `value pill log-${log.level}`;
  
  elDetailDuration.textContent = log.details && log.details.durationMs 
    ? `${log.details.durationMs} ms` 
    : 'N/A';
    
  elDetailTokens.textContent = log.details && log.details.promptTokens !== undefined
    ? `Prompt: ${log.details.promptTokens} | Completion: ${log.details.completionTokens}`
    : 'N/A';
    
  if (log.details) {
    elDetailCode.textContent = JSON.stringify(log.details, null, 2);
    elDetailCode.parentElement.style.display = 'flex';
  } else {
    elDetailCode.parentElement.style.display = 'none';
  }
  
  elModalOverlay.classList.add('active');
}

// 3. Form config post
elConfigForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const payload = {
    port: parseInt(elInputPort.value),
    lmStudioUrl: elInputUrl.value,
    bridgeApiKey: elInputBridgeKey.value,
    lmStudioApiKey: elInputLmKey.value,
    autoMapModel: elChkAutoMap.checked,
    sanitizeResponse: elChkSanitize.checked
  };
  
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) throw new Error('Failed to update config');
    
    alert('Configuration saved successfully! If you changed the port, you will need to restart the server.');
    updateStatus();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

// 4. Test connectivity
elBtnTestPing.addEventListener('click', async () => {
  try {
    elBtnTestPing.disabled = true;
    elBtnTestPing.textContent = 'Pinging...';
    
    const response = await fetch('/api/test-connection', { method: 'POST' });
    const data = await response.json();
    
    if (data.online) {
      alert(`Success! Connected to LM Studio.\nLoaded models count: ${data.models.length}`);
    } else {
      alert(`Connection failed: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    alert(`Network Error: ${err.message}`);
  } finally {
    elBtnTestPing.disabled = false;
    elBtnTestPing.textContent = 'Ping LM Studio';
  }
});

// 5. Submit model test
elBtnSubmitTest.addEventListener('click', async () => {
  const promptText = elTxtPlaygroundPrompt.value.trim();
  if (!promptText) {
    alert('Please enter a prompt first.');
    return;
  }
  
  try {
    elBtnSubmitTest.disabled = true;
    elSpinnerTest.style.display = 'inline-block';
    elPlaygroundResultBox.style.display = 'none';
    
    // Query our own proxy completions endpoint using default test values
    const headers = { 'Content-Type': 'application/json' };
    if (elInputBridgeKey.value) {
      headers['Authorization'] = `Bearer ${elInputBridgeKey.value}`;
    }
    
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: 'playground-test',
        messages: [
          { role: 'user', content: promptText }
        ]
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message || 'API Completion error');
    }
    
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : JSON.stringify(data, null, 2);
      
    elPlaygroundOutput.textContent = content;
    elPlaygroundResultBox.style.display = 'flex';
  } catch (err) {
    alert(`Model call failed: ${err.message}`);
  } finally {
    elBtnSubmitTest.disabled = false;
    elSpinnerTest.style.display = 'none';
  }
});

// 6. RimWorld Integration UI Linker
const elBadgeRimworld = document.getElementById('badge-rimworld-status');
const elXmlFile = document.getElementById('lbl-xml-file');
const elXmlEndpoint = document.getElementById('lbl-xml-endpoint');
const elXmlKey = document.getElementById('lbl-xml-key');
const elBtnLinkRimworld = document.getElementById('btn-link-rimworld');

async function updateRimWorldConfigStatus() {
  try {
    const response = await fetch('/api/rimworld-config');
    if (!response.ok) throw new Error('Failed to fetch RimWorld status');
    const data = await response.json();
    
    if (data.found) {
      elXmlFile.textContent = data.fileName;
      elXmlFile.title = data.filePath;
      elXmlEndpoint.textContent = data.apiEndpoint || 'Not Set';
      elXmlEndpoint.title = data.apiEndpoint || '';
      elXmlKey.textContent = data.apiKey ? '••••••••' : 'Not Set';
      elXmlKey.title = data.apiKey || '';
      
      // Determine if endpoints are pointing to the bridge
      const currentPort = window.location.port || '3000';
      const expectedEndpoint = `https://localhost:${currentPort}/v1`;
      const expectedKey = 'rimmind-bridge'; // default
      
      const isLinked = (data.apiEndpoint === expectedEndpoint || data.apiEndpoint === `http://localhost:${currentPort}/v1`) &&
                       data.apiKey !== '';
                       
      if (isLinked) {
        elBadgeRimworld.textContent = 'Linked';
        elBadgeRimworld.className = 'status-badge status-linked';
        elBtnLinkRimworld.disabled = true;
        elBtnLinkRimworld.querySelector('span').textContent = 'RimWorld Configured';
      } else {
        elBadgeRimworld.textContent = 'Not Linked';
        elBadgeRimworld.className = 'status-badge status-unlinked';
        elBtnLinkRimworld.disabled = false;
        elBtnLinkRimworld.querySelector('span').textContent = 'Link Mod Settings';
      }
    } else {
      elBadgeRimworld.textContent = 'Offline';
      elBadgeRimworld.className = 'status-badge status-unlinked';
      elXmlFile.textContent = 'Not Found';
      elXmlFile.title = `Searched: ${data.searchPath || 'N/A'}`;
      elXmlEndpoint.textContent = '-';
      elXmlKey.textContent = '-';
      elBtnLinkRimworld.disabled = true;
      elBtnLinkRimworld.querySelector('span').textContent = 'Auto-Detecting...';
    }
  } catch (err) {
    console.error('Error fetching RimWorld link status:', err);
  }
}

elBtnLinkRimworld.addEventListener('click', async () => {
  try {
    elBtnLinkRimworld.disabled = true;
    elBtnLinkRimworld.querySelector('span').textContent = 'Configuring...';
    
    const response = await fetch('/api/rimworld-config', { method: 'POST' });
    const data = await response.json();
    
    if (data.success) {
      alert('RimWorld mod settings file updated successfully! Exiting and restarting RimWorld is recommended if it was already running.');
      updateRimWorldConfigStatus();
    } else {
      alert(`Configuration failed: ${data.message}`);
    }
  } catch (err) {
    alert(`Error updating settings: ${err.message}`);
  } finally {
    updateRimWorldConfigStatus();
  }
});

// 7. Utility handlers
elBtnClearLogs.addEventListener('click', () => {
  elLogsContainer.innerHTML = `<div class="log-placeholder">Activity logs cleared.</div>`;
  logsMap.clear();
});

elBtnRefreshModels.addEventListener('click', () => {
  updateStatus();
  updateRimWorldConfigStatus();
});

elBtnCloseModal.addEventListener('click', () => {
  elModalOverlay.classList.remove('active');
});

elModalOverlay.addEventListener('click', (e) => {
  if (e.target === elModalOverlay) {
    elModalOverlay.classList.remove('active');
  }
});

// Startup
updateStatus();
updateRimWorldConfigStatus();
initializeSSE();

// Poll state every 3s
setInterval(() => {
  updateStatus();
  updateRimWorldConfigStatus();
}, 3000);
