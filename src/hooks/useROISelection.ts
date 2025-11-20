import { useState, useCallback, useRef } from 'react';

export interface ROI {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const useROISelection = (canvasRef: React.RefObject<HTMLCanvasElement>) => {
  const [roi, setRoi] = useState<ROI | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const startPoint = useRef<{ x: number; y: number } | null>(null);

  const getCanvasCoordinates = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return null;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    
    let clientX: number, clientY: number;
    
    if ('touches' in e) {
      if (e.touches.length === 0) return null;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }, [canvasRef]);

  const handlePointerDown = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const coords = getCanvasCoordinates(e);
    if (coords) {
      setIsDrawing(true);
      startPoint.current = coords;
      setRoi(null);
    }
  }, [getCanvasCoordinates]);

  const handlePointerMove = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !startPoint.current) return;
    
    e.preventDefault();
    const coords = getCanvasCoordinates(e);
    if (!coords) return;

    const x = Math.min(startPoint.current.x, coords.x);
    const y = Math.min(startPoint.current.y, coords.y);
    const w = Math.abs(coords.x - startPoint.current.x);
    const h = Math.abs(coords.y - startPoint.current.y);

    setRoi({ x, y, w, h });
  }, [isDrawing, getCanvasCoordinates]);

  const handlePointerUp = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false);
      startPoint.current = null;
    }
  }, [isDrawing]);

  const clearROI = useCallback(() => {
    setRoi(null);
    setIsDrawing(false);
    startPoint.current = null;
  }, []);

  return {
    roi,
    isDrawing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    clearROI
  };
};
