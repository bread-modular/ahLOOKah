// Internal visual source, not a pattern dependency or registry entry. GraphRuntime
// instantiates it only on the output with an available shared camera manager.
// deviceId is selected by the graph node (null follows Settings/videoDeviceId).
export const CAMERA_NODE_PATTERN = Object.freeze({
  id: '__graph_camera_source',
  name: 'Camera',
  camera: true,
  params: [],
  factory: (_audio, _deviceId, _params, context) => p => {
    let lease;
    p.setup = () => {
      p.createCanvas(p.windowWidth, p.windowHeight);
      // The shared manager owns the stream; ProgramRuntime owns and releases
      // only this consumer's lease. Never fall back to p.createCapture here.
      lease = context.createCapture(p, { video: true, audio: false });
      lease?.hide?.();
    };
    p.draw = () => {
      const video = lease?.elt;
      if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return false;
      const ctx = p.drawingContext;
      ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      ctx.drawImage(video, 0, 0, p.canvas.width, p.canvas.height);
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
  },
});
