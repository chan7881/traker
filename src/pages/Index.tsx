import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VideoCanvas, VideoCanvasHandle } from '@/components/VideoCanvas';
import { useVideoFrame } from '@/hooks/useVideoFrame';
import { useROISelection } from '@/hooks/useROISelection';
import { useToast } from '@/hooks/use-toast';
import { Upload, Camera, Play, ChevronLeft, ChevronRight, Target, BarChart3 } from 'lucide-react';

const Index = () => {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState('upload');
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [fps, setFps] = useState(10);
  const [frameROIs, setFrameROIs] = useState<Map<number, any>>(new Map());
  
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoCanvasRef = useRef<VideoCanvasHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const { extractedFrames, isExtracting, progress, extractFrames, reset } = useVideoFrame();
  const { roi, handlePointerDown, handlePointerMove, handlePointerUp, clearROI } = useROISelection(canvasRef);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('video/')) {
      toast({
        title: "Invalid file type",
        description: "Please upload a video file",
        variant: "destructive"
      });
      return;
    }

    // Revoke previous URL
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }

    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    reset();
    setCurrentFrameIndex(0);
    setFrameROIs(new Map());
    
    toast({
      title: "Video loaded",
      description: `${file.name} has been loaded successfully`
    });
  }, [videoUrl, reset, toast]);

  const handleExtractFrames = useCallback(async () => {
    const videoElement = videoCanvasRef.current?.getVideoElement();
    if (!videoElement) {
      toast({
        title: "No video",
        description: "Please upload a video first",
        variant: "destructive"
      });
      return;
    }

    try {
      await extractFrames(videoElement, fps);
      setCurrentTab('frames');
      toast({
        title: "Frames extracted",
        description: `Successfully extracted ${Math.floor(videoElement.duration * fps)} frames`
      });
    } catch (error) {
      toast({
        title: "Extraction failed",
        description: error instanceof Error ? error.message : "Failed to extract frames",
        variant: "destructive"
      });
    }
  }, [extractFrames, fps, toast]);

  const handleStartCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      
      // Create video element from stream
      const video = document.createElement('video');
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      await video.play();
      
      toast({
        title: "Camera started",
        description: "Camera access granted"
      });
    } catch (error) {
      toast({
        title: "Camera error",
        description: "Could not access camera. Please check permissions.",
        variant: "destructive"
      });
    }
  }, [toast]);

  const handlePrevFrame = useCallback(() => {
    if (currentFrameIndex > 0) {
      setCurrentFrameIndex(prev => prev - 1);
    }
  }, [currentFrameIndex]);

  const handleNextFrame = useCallback(() => {
    if (currentFrameIndex < extractedFrames.length - 1) {
      setCurrentFrameIndex(prev => prev + 1);
    }
  }, [currentFrameIndex, extractedFrames.length]);

  const handleSaveROI = useCallback(() => {
    if (roi) {
      setFrameROIs(prev => new Map(prev).set(currentFrameIndex, roi));
      toast({
        title: "ROI saved",
        description: `ROI saved for frame ${currentFrameIndex + 1}`
      });
    }
  }, [roi, currentFrameIndex, toast]);

  const currentFrame = extractedFrames[currentFrameIndex] || null;
  const showVideo = currentTab === 'upload' || (currentTab === 'extract' && extractedFrames.length === 0);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-4 max-w-6xl">
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold bg-gradient-primary bg-clip-text text-transparent mb-2">
            Motion Tracker
          </h1>
          <p className="text-muted-foreground">
            동영상에서 물체를 지정해 운동을 분석합니다 (모바일 지원)
          </p>
        </header>

        <Tabs value={currentTab} onValueChange={setCurrentTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-4 bg-card">
            <TabsTrigger value="upload" className="data-[state=active]:bg-gradient-primary data-[state=active]:text-primary-foreground">
              <Upload className="w-4 h-4 mr-2" />
              1. 촬영
            </TabsTrigger>
            <TabsTrigger value="extract" className="data-[state=active]:bg-gradient-primary data-[state=active]:text-primary-foreground">
              <Play className="w-4 h-4 mr-2" />
              2. 프레임 추출
            </TabsTrigger>
            <TabsTrigger value="roi" className="data-[state=active]:bg-gradient-primary data-[state=active]:text-primary-foreground">
              <Target className="w-4 h-4 mr-2" />
              3. ROI 선택
            </TabsTrigger>
            <TabsTrigger value="analyze" className="data-[state=active]:bg-gradient-primary data-[state=active]:text-primary-foreground">
              <BarChart3 className="w-4 h-4 mr-2" />
              4. 결과
            </TabsTrigger>
          </TabsList>

          <div className="grid md:grid-cols-3 gap-6">
            <Card className="md:col-span-2 p-6 bg-card border-border">
              <VideoCanvas
                ref={videoCanvasRef}
                videoUrl={videoUrl}
                currentFrame={currentFrame}
                roi={currentTab === 'roi' ? roi : frameROIs.get(currentFrameIndex) || null}
                onPointerDown={currentTab === 'roi' ? handlePointerDown : undefined}
                onPointerMove={currentTab === 'roi' ? handlePointerMove : undefined}
                onPointerUp={currentTab === 'roi' ? handlePointerUp : undefined}
                showVideo={showVideo}
              />
            </Card>

            <Card className="p-6 bg-card border-border space-y-4">
              <TabsContent value="upload" className="mt-0 space-y-4">
                <div>
                  <Label htmlFor="video-upload" className="text-lg font-semibold mb-3 block">
                    비디오 업로드
                  </Label>
                  <input
                    ref={fileInputRef}
                    id="video-upload"
                    type="file"
                    accept="video/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full bg-gradient-primary hover:opacity-90"
                    size="lg"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    파일 선택
                  </Button>
                </div>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">또는</span>
                  </div>
                </div>

                <Button
                  onClick={handleStartCamera}
                  variant="outline"
                  className="w-full"
                  size="lg"
                >
                  <Camera className="w-4 h-4 mr-2" />
                  카메라 켜기
                </Button>

                <p className="text-sm text-muted-foreground text-center mt-4">
                  카메라로 촬영하거나 비디오 파일을 업로드하세요
                </p>
              </TabsContent>

              <TabsContent value="extract" className="mt-0 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="fps">프레임레이트 (FPS)</Label>
                  <Input
                    id="fps"
                    type="number"
                    min="1"
                    max="60"
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                    className="bg-secondary"
                  />
                </div>

                <Button
                  onClick={handleExtractFrames}
                  disabled={!videoUrl || isExtracting}
                  className="w-full bg-gradient-primary hover:opacity-90"
                  size="lg"
                >
                  {isExtracting ? '추출 중...' : '프레임 추출 시작'}
                </Button>

                {isExtracting && (
                  <div className="space-y-2">
                    <Progress value={progress} className="w-full" />
                    <p className="text-sm text-center text-muted-foreground">{progress}%</p>
                  </div>
                )}

                {extractedFrames.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-sm font-medium">
                      {extractedFrames.length}개 프레임 추출 완료
                    </p>
                    
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={handlePrevFrame}
                        disabled={currentFrameIndex === 0}
                        variant="outline"
                        size="sm"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      
                      <div className="flex-1 text-center text-sm">
                        Frame {currentFrameIndex + 1} / {extractedFrames.length}
                      </div>
                      
                      <Button
                        onClick={handleNextFrame}
                        disabled={currentFrameIndex >= extractedFrames.length - 1}
                        variant="outline"
                        size="sm"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="roi" className="mt-0 space-y-4">
                {extractedFrames.length > 0 ? (
                  <>
                    <div className="space-y-2">
                      <p className="text-sm font-medium">ROI 선택</p>
                      <p className="text-xs text-muted-foreground">
                        캔버스를 드래그하여 관심 영역을 선택하세요
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        onClick={handlePrevFrame}
                        disabled={currentFrameIndex === 0}
                        variant="outline"
                        size="sm"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      
                      <div className="flex-1 text-center text-sm">
                        Frame {currentFrameIndex + 1} / {extractedFrames.length}
                      </div>
                      
                      <Button
                        onClick={handleNextFrame}
                        disabled={currentFrameIndex >= extractedFrames.length - 1}
                        variant="outline"
                        size="sm"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>

                    {roi && (
                      <Button
                        onClick={handleSaveROI}
                        className="w-full bg-gradient-primary hover:opacity-90"
                      >
                        <Target className="w-4 h-4 mr-2" />
                        ROI 저장
                      </Button>
                    )}

                    <Button
                      onClick={clearROI}
                      variant="outline"
                      className="w-full"
                    >
                      ROI 초기화
                    </Button>

                    <div className="pt-4 border-t border-border">
                      <p className="text-xs text-muted-foreground">
                        저장된 ROI: {frameROIs.size} / {extractedFrames.length}
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    먼저 프레임을 추출해주세요
                  </p>
                )}
              </TabsContent>

              <TabsContent value="analyze" className="mt-0 space-y-4">
                <p className="text-sm text-muted-foreground">
                  분석 결과가 여기에 표시됩니다
                </p>
                {frameROIs.size > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">추적 통계</p>
                    <p className="text-xs text-muted-foreground">
                      {frameROIs.size}개 프레임에 ROI가 지정되었습니다
                    </p>
                  </div>
                )}
              </TabsContent>
            </Card>
          </div>
        </Tabs>
      </div>
    </div>
  );
};

export default Index;
