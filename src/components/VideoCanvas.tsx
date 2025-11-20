import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { ROI } from '@/hooks/useROISelection';
import { ExtractedFrame } from '@/hooks/useVideoFrame';

interface VideoCanvasProps {
  videoUrl: string | null;
  currentFrame: ExtractedFrame | null;
  roi: ROI | null;
  onPointerDown?: (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => void;
  onPointerUp?: () => void;
  showVideo?: boolean;
}

export interface VideoCanvasHandle {
  getVideoElement: () => HTMLVideoElement | null;
}

export const VideoCanvas = forwardRef<VideoCanvasHandle, VideoCanvasProps>(({
  videoUrl,
  currentFrame,
  roi,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  showVideo = true
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    getVideoElement: () => videoRef.current
  }));

  // Draw current frame or video
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw video or frame
      if (currentFrame) {
        // Draw extracted frame
        ctx.drawImage(currentFrame.canvas, 0, 0, canvas.width, canvas.height);
      } else if (videoRef.current && showVideo && videoUrl) {
        // Draw video
        if (videoRef.current.readyState >= 2) {
          ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        }
      }

      // Draw ROI
      if (roi && roi.w > 0 && roi.h > 0) {
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 3;
        ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
        
        // Semi-transparent fill
        ctx.fillStyle = 'rgba(6, 182, 212, 0.1)';
        ctx.fillRect(roi.x, roi.y, roi.w, roi.h);

        // Crosshair at center
        const centerX = roi.x + roi.w / 2;
        const centerY = roi.y + roi.h / 2;
        ctx.strokeStyle = '#4fd1c5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(centerX - 10, centerY);
        ctx.lineTo(centerX + 10, centerY);
        ctx.moveTo(centerX, centerY - 10);
        ctx.lineTo(centerX, centerY + 10);
        ctx.stroke();
      }
    };

    draw();

    // Redraw on video play
    let animationId: number;
    if (showVideo && !currentFrame && videoRef.current && videoUrl) {
      const animate = () => {
        draw();
        animationId = requestAnimationFrame(animate);
      };
      animate();
    }

    return () => {
      if (animationId) cancelAnimationFrame(animationId);
    };
  }, [currentFrame, roi, showVideo, videoUrl]);

  // Set canvas size when video loads
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !canvasRef.current) return;

    const handleLoadedMetadata = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    
    if (video.readyState >= 1) {
      handleLoadedMetadata();
    }

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [videoUrl]);

  return (
    <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden">
      {videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          className={`absolute inset-0 w-full h-full object-contain ${showVideo && !currentFrame ? 'block' : 'hidden'}`}
          playsInline
          muted
          controls={showVideo && !currentFrame}
        />
      )}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-contain cursor-crosshair touch-none"
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={onPointerUp}
        onMouseLeave={onPointerUp}
        onTouchStart={onPointerDown}
        onTouchMove={onPointerMove}
        onTouchEnd={onPointerUp}
        width={640}
        height={480}
      />
    </div>
  );
});

VideoCanvas.displayName = 'VideoCanvas';
