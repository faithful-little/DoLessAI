// Pending sandbox script requests
const pendingSandboxRequests = new Map();

// Listen for messages from sandbox iframe
window.addEventListener('message', async (event) => {
  // Handle sandbox script execution completion
  if (event.data.type === 'EXECUTION_COMPLETE') {
    const { success, result, error, messageId } = event.data;

    if (pendingSandboxRequests.has(messageId)) {
      pendingSandboxRequests.delete(messageId);
      chrome.runtime.sendMessage({
        type: 'sandbox-script-result',
        success,
        result,
        error,
        messageId
      });
    }
  }

  // Handle driver actions from sandbox (click, type, wait, etc.)
  if (event.data.type === 'DRIVER_ACTION') {
    const { action, data, messageId } = event.data;

    // Forward to background script for execution on the actual page
    chrome.runtime.sendMessage({
      type: 'DRIVER_ACTION',
      action,
      data,
      messageId
    });
  }
});

// Listen for driver action results from background to relay to sandbox
chrome.runtime.onMessage.addListener(async (message) => {
  // Relay driver action results back to sandbox
  if (message.type === 'DRIVER_ACTION_RESULT' && message.target === 'offscreen') {
    const sandbox = document.getElementById('sandbox');
    if (sandbox && sandbox.contentWindow) {
      sandbox.contentWindow.postMessage({
        type: 'DRIVER_ACTION_RESULT',
        messageId: message.messageId,
        success: message.success,
        result: message.result,
        error: message.error
      }, '*');
    }
    return;
  }

  if (message.target !== 'offscreen') return;

  if (message.type === 'stitch-images') {
    const { captures, width, height, vh } = message.data;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < captures.length; i++) {
      const imageBlob = await (await fetch(captures[i])).blob();
      const imageBitmap = await createImageBitmap(imageBlob);
      ctx.drawImage(imageBitmap, 0, i * vh);
    }

    const stitchedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const reader = new FileReader();
    reader.onload = () => {
      chrome.runtime.sendMessage({ type: 'stitchedImage', dataUrl: reader.result });
      chrome.offscreen.closeDocument();
    };
    reader.readAsDataURL(stitchedBlob);
  }

  if (message.type === 'process-screenshot-with-element') {
    const { screenshot, rect, elementName, scroll, viewport, devicePixelRatio } = message.data;

    try {
      const imageBlob = await (await fetch(screenshot)).blob();
      const imageBitmap = await createImageBitmap(imageBlob);

      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0);

      // Calculate actual positions accounting for device pixel ratio if needed (assuming 1:1 for now based on captureVisibleTab)
      // Rect from content script is relative to viewport. captureVisibleTab is viewport.
      // So we can use rect directly, but need to consider scroll if we were capturing full page.
      // For captureVisibleTab, it captures what's in the viewport.
      // The rect from getBoundingClientRect is relative to the viewport top-left.
      // So rect.x and rect.y are correct for the screenshot.

      // Scaling Factor
      // captureVisibleTab returns image in physical pixels (usually).
      // rect is in CSS pixels.
      // We need to scale rect by devicePixelRatio.
      const scale = devicePixelRatio || 1;

      // Draw Label and Box
      if (rect) {
        const scaledRect = {
          x: rect.x * scale,
          y: rect.y * scale,
          width: rect.width * scale,
          height: rect.height * scale
        };

        ctx.strokeStyle = 'red';
        ctx.lineWidth = 3 * scale; // Scale line width too
        ctx.strokeRect(scaledRect.x, scaledRect.y, scaledRect.width, scaledRect.height);

        // Draw crosshair/dot at center
        const centerX = scaledRect.x + scaledRect.width / 2;
        const centerY = scaledRect.y + scaledRect.height / 2;

        ctx.fillStyle = 'red';
        ctx.beginPath();
        ctx.arc(centerX, centerY, 5 * scale, 0, 2 * Math.PI);
        ctx.fill();

        // Draw Text Label
        const fontSize = 16 * scale;
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = 'red';
        const label = elementName || 'Target';
        const textWidth = ctx.measureText(label).width;

        const padding = 5 * scale;
        const labelHeight = fontSize + padding * 2;

        // Adjust label position to stay within bounds if possible
        let labelY = scaledRect.y - labelHeight;
        if (labelY < 0) labelY = scaledRect.y + scaledRect.height; // Put below if above is cut off

        ctx.fillRect(scaledRect.x, labelY, textWidth + (padding * 2), labelHeight);
        ctx.fillStyle = 'white';
        ctx.fillText(label, scaledRect.x + padding, labelY + fontSize); // Check baseline
      }

      const labeledBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });

      let croppedDataUrl = null;
      if (rect && rect.width > 0 && rect.height > 0) {
        // Crop Element
        try {
          const scale = devicePixelRatio || 1;
          const scaledRect = {
            x: rect.x * scale,
            y: rect.y * scale,
            width: rect.width * scale,
            height: rect.height * scale
          };

          // Ensure crop is within bounds
          const safeX = Math.max(0, scaledRect.x);
          const safeY = Math.max(0, scaledRect.y);
          const safeW = Math.min(scaledRect.width, imageBitmap.width - safeX);
          const safeH = Math.min(scaledRect.height, imageBitmap.height - safeY);

          if (safeW > 0 && safeH > 0) {
            const cropCanvas = new OffscreenCanvas(safeW, safeH);
            const cropCtx = cropCanvas.getContext('2d');
            cropCtx.drawImage(imageBitmap, safeX, safeY, safeW, safeH, 0, 0, safeW, safeH);
            const croppedBlob = await cropCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
            croppedDataUrl = await new Promise(r => { const red = new FileReader(); red.onload = () => r(red.result); red.readAsDataURL(croppedBlob); });
          }
        } catch (cropError) {
          console.error("Crop failed", cropError);
        }
      }

      const reader = new FileReader();
      reader.onload = () => {
        chrome.runtime.sendMessage({
          type: 'processed-screenshot',
          labeledDataUrl: reader.result,
          croppedDataUrl: croppedDataUrl,
          originalStepId: message.data.originalStepId // Pass back ID to match
        });
        // We don't close here because we might need it again quickly, but offscreens have lifetime limits.
        // Best practice for this frequent usage is to keep it open or rely on background to manage it.
        // For now, we won't close it explicitly after every single event to avoid overhead, 
        // but the background might spawn it on demand. 
        // Actually, let's close it to be safe and simple for now, unless performance implies otherwise.
        // If the background script keeps creating it, better to close it. 
        // chrome.offscreen.closeDocument(); // Cannot be called from here
      };
      reader.readAsDataURL(labeledBlob);

    } catch (err) {
      console.error("Image processing failed:", err);
      // chrome.offscreen.closeDocument(); // Cannot be called from here
    }
  }

  // --- Audio Recording Logic ---
  if (message.type === 'start-recording-audio') {
    startRecordingAudio(message.deviceId);
  }
  if (message.type === 'stop-recording-audio') {
    stopRecordingAudio();
  }
  if (message.type === 'get-audio-devices') {
    getAudioDevices();
  }

  // --- Sandbox Script Execution ---
  if (message.type === 'execute-sandbox-script') {
    const sandbox = document.getElementById('sandbox');
    if (!sandbox || !sandbox.contentWindow) {
      chrome.runtime.sendMessage({
        type: 'sandbox-script-result',
        success: false,
        error: 'Sandbox iframe not available',
        messageId: message.messageId
      });
      return;
    }

    // Store pending request for response matching
    pendingSandboxRequests.set(message.messageId, true);

    // Forward to sandbox iframe
    sandbox.contentWindow.postMessage({
      command: 'EXECUTE_DRIVER_SCRIPT',
      scriptCode: message.scriptCode,
      inputs: message.inputs,
      messageId: message.messageId
    }, '*');
  }

});

let mediaRecorder = null;
let audioChunks = [];
let audioStream = null; // Store stream at module level

async function startRecordingAudio(deviceId = null) {
  try {
    const constraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    };
    audioStream = await navigator.mediaDevices.getUserMedia(constraints);
    mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      if (audioChunks.length === 0) {
        console.warn("Audio recording produced no data.");
        return;
      }
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = () => {
        const base64data = reader.result;
        chrome.runtime.sendMessage({ type: 'audioRecorded', audioData: base64data });
      };

      // Stop all tracks
      if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
      }
    };

    // Start with timeslice to ensure data is captured periodically
    mediaRecorder.start(100); // Capture every 100ms
    console.log("Audio recording started.");
  } catch (err) {
    console.error("Error starting audio recording:", err);
    chrome.runtime.sendMessage({ type: 'audioRecorded', audioData: null, error: err.message });
  }
}

function stopRecordingAudio() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    console.log("Audio recording stopped.");
  }
}