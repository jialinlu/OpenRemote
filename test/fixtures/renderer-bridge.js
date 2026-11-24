/* Browser-only fixture. Never shipped as part of the desktop application. */
(() => {
  const handlers = [];
  const smoke = window.__rendererSmoke = {
    pcs: [], tracks: [], captureRequests: [], inputs: [], domKeys: [], connected: false,
    emit(event) { for (const handler of handlers) handler(event); },
  };
  document.addEventListener('keydown', event => smoke.domKeys.push({ code: event.code, repeat: event.repeat }), true);
  const NativePeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeerConnection {
    constructor(...args) { super(...args); smoke.pcs.push(this); }
  };
  const names = ['snapshot', 'saveSettings', 'copyInvitation', 'copyPairCode', 'pair', 'pairMode', 'setSessionViewOnly',
    'approvePair', 'rejectPair', 'retryPair', 'cancelPair', 'revoke', 'peerControl', 'connect', 'disconnect', 'pauseHosting', 'sessionFailed',
    'signal', 'captureSource', 'input', 'sessionConnected', 'sessionAlive', 'sessionStats', 'permissions',
    'openPermissions', 'listDisplays', 'startQuickConnect', 'stopQuickConnect', 'sessionReady', 'showSession', 'toggleFullscreen', 'exportConnection', 'importConnection',
    'getSshProfile', 'openSsh'];
  window.bridge = Object.fromEntries(names.map(name => [name, (...args) => window.__smokeInvoke(name, args)]));
  window.bridge.onEvent = callback => {
    handlers.push(callback);
    return () => { const index = handlers.indexOf(callback); if (index >= 0) handlers.splice(index, 1); };
  };
  Object.freeze(window.bridge);
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async constraints => {
      smoke.captureRequests.push(constraints);
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        frame++;
        ctx.fillStyle = '#f3f8f3'; ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = '#173e2d'; ctx.fillRect(0, 0, 1280, 104);
        ctx.fillStyle = '#ffffff'; ctx.font = '30px sans-serif';
        ctx.fillText('OpenRemote synthetic WebRTC test', 36, 63);
        ctx.fillStyle = '#276e4b'; ctx.fillRect(40 + (frame * 7) % 1000, 180, 160, 160);
        ctx.fillStyle = '#24362a'; ctx.font = '24px monospace';
        ctx.fillText(`Canvas frame ${frame}`, 40, 430);
        ctx.fillText('No screen capture. No native input.', 40, 478);
        ctx.fillStyle = '#b7d6bf';
        for (let x = 40; x < 1200; x += 44) ctx.fillRect(x, 560 + Math.sin(frame / 15 + x) * 30, 26, 50);
      };
      draw();
      const timer = setInterval(draw, 1000 / 30);
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0];
      smoke.tracks.push(track);
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    },
  });
})();
