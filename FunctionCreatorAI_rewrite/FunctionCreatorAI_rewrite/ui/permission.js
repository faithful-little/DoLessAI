document.getElementById('requestBtn').addEventListener('click', async () => {
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        document.body.innerHTML = '<h1>Permission Granted!</h1><p>You can close this tab now.</p>';
    } catch (e) {
        document.body.innerHTML = '<h1>Error</h1><p>' + e.message + '</p>';
    }
});
