import { useState, useCallback, useRef } from 'react';

export interface ExtractedFrame {
  canvas: HTMLCanvasElement;
  timestamp: number;
  index: number;
}

export const useVideoFrame = () => {
  const [extractedFrames, setExtractedFrames] = useState<ExtractedFrame[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const extractFrames = useCallback(async (videoElement: HTMLVideoElement, fps: number = 10) => {
    if (!videoElement || isExtracting) return;

    setIsExtracting(true);
    setProgress(0);
    const frames: ExtractedFrame[] = [];

    try {
      const duration = videoElement.duration;
      if (!duration || !isFinite(duration)) {
        throw new Error('Invalid video duration');
      }

      const interval = 1 / fps;
      const totalFrames = Math.floor(duration * fps);

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');

      // Wait for video metadata
      if (videoElement.readyState < 2) {
        await new Promise((resolve) => {
          videoElement.addEventListener('loadedmetadata', resolve, { once: true });
        });
      }

      canvas.width = videoElement.videoWidth || 640;
      canvas.height = videoElement.videoHeight || 480;

      for (let i = 0; i < totalFrames; i++) {
        const timestamp = i * interval;
        
        // Seek to timestamp
        videoElement.currentTime = timestamp;
        
        // Wait for seek to complete
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            videoElement.removeEventListener('seeked', onSeeked);
            resolve();
          };
          videoElement.addEventListener('seeked', onSeeked);
        });

        // Small delay for mobile browsers
        await new Promise(resolve => requestAnimationFrame(resolve));

        // Draw frame
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

        // Create a copy of the canvas
        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = canvas.width;
        frameCanvas.height = canvas.height;
        const frameCtx = frameCanvas.getContext('2d');
        if (frameCtx) {
          frameCtx.drawImage(canvas, 0, 0);
          
          frames.push({
            canvas: frameCanvas,
            timestamp,
            index: i
          });
        }

        setProgress(Math.round(((i + 1) / totalFrames) * 100));
      }

      setExtractedFrames(frames);
      console.log(`Extracted ${frames.length} frames`);
    } catch (error) {
      console.error('Frame extraction error:', error);
      throw error;
    } finally {
      setIsExtracting(false);
    }
  }, [isExtracting]);

  const reset = useCallback(() => {
    setExtractedFrames([]);
    setProgress(0);
  }, []);

  return {
    extractedFrames,
    isExtracting,
    progress,
    extractFrames,
    reset,
    videoRef
  };
};
