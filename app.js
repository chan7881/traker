/**
 * Motion Tracker App - 최소 동작 버전 (수정)
 * 
 * 핵심: 파일 업로드 & 카메라 촬영만 먼저 동작시키기
 */

console.log('[Traker] 앱 시작...');

// ============================================================================
// DOM Elements
// ============================================================================

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const videoFile = document.getElementById('videoFile');
const startCameraBtn = document.getElementById('startCamera');
const recordToggleBtn = document.getElementById('recordToggle');
const extractFramesBtn = document.getElementById('extractFramesBtn');
const prevFrameBtn = document.getElementById('prevFrame');
const nextFrameBtn = document.getElementById('nextFrame');
const frameIdxEl = document.getElementById('frameIdx');
const selectROIBtn = document.getElementById('frameROI');
const completeROIsBtn = document.getElementById('completeROIs');
const runDetectBtn = document.getElementById('selectROI');
const exportCSVBtn = document.getElementById('exportCSV');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const extractProgress = document.getElementById('extractProgress');

// Global state
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let extractedFrames = [];
let currentFrameIndex = 0;
let frameROIs = {};
let isExtracting = false;
let roi = null;
let detectionsPerFrame = [];
let analysisResult = null;
let scalePxPerUnit = getScaleValue();

function getScaleValue() {
  const el = document.getElementById('scaleInput');
  return parseFloat(el?.value) || 1;
}

function getFpsValue() {
  const el = document.querySelector('#tab-2 #fpsInput') || document.getElementById('fpsInput');
  return Number(el?.value) || 10;
}

// ============================================================================
// UTILITY: 사용자 로그
// ============================================================================

function log(msg) {
  console.log('[Traker]', msg);
  try {
    let el = document.getElementById('mobileStatusLog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mobileStatusLog';
      Object.assign(el.style, {
        position: 'fixed', left: '8px', right: '8px', bottom: '12px',
        padding: '8px 10px', background: 'rgba(0,0,0,0.8)', color: '#fff',
        fontSize: '11px', zIndex: '9999', maxHeight: '140px', overflow: 'auto'
      });
      document.body.appendChild(el);
    }
    const p = document.createElement('div');
    p.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    el.appendChild(p);
    while (el.childNodes.length > 6) el.removeChild(el.firstChild);
  } catch (e) { }
}

// ============================================================================
// FILE UPLOAD HANDLER
// ============================================================================

if (videoFile) {
  videoFile.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) {
      log('❌ 파일 선택 취소됨');
      return;
    }
    log(`📄 파일 선택됨: ${f.name}`);

    try {
      const url = URL.createObjectURL(f);
      video.src = url;

      video.onloadedmetadata = () => {
        log(`✔ 비디오 로드됨: ${Math.round(video.duration)}초, ${video.videoWidth}x${video.videoHeight}`);
        if (extractFramesBtn) extractFramesBtn.disabled = false;
      };

      video.play().catch(err => log(`⚠ 재생 실패: ${err.message}`));
    } catch (err) {
      log(`❌ 파일 처리 중 오류 발생: ${err.message}`);
    }
  });
  log('📁 파일 업로드 리스너 등록됨');
} else {
  console.error('❌ videoFile 요소 없음!');
}

// ============================================================================
// CAMERA HANDLER
// ============================================================================

if (startCameraBtn) {
  startCameraBtn.addEventListener('click', async () => {
    log('📷 카메라 버튼 클릭...');
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });
      log('✓ 카메라 스트림 획득됨');
      
      video.srcObject = currentStream;
      video.onloadedmetadata = () => {
        log(`✓ 카메라 준비됨: ${video.videoWidth}x${video.videoHeight}`);
      };
      
      video.play().catch(err => log(`⚠ 재생 실패: ${err.message}`));
      
      if (recordToggleBtn) {
        recordToggleBtn.disabled = false;
        recordToggleBtn.style.display = '';
      }
    } catch (err) {
      log(`❌ 카메라 접근 실패: ${err.message}`);
      alert('카메라 접근: ' + err.message);
    }
  });
  log('🎥 카메라 리스너 등록됨');
} else {
  console.error('❌ startCameraBtn 요소 없음!');
}

// ============================================================================
// RECORD HANDLER
// ============================================================================

if (recordToggleBtn) {
  recordToggleBtn.addEventListener('click', () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      if (!currentStream) {
        log('❌ 활성 카메라가 없습니다');
        return;
      }
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(currentStream);
      log('🔴 녹화 시작...');
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        log(`✓ 녹화 완료: ${Math.round(blob.size / 1024)}KB`);
        
        video.src = URL.createObjectURL(blob);
        video.onloadedmetadata = () => {
          log(`✓ 녹화 비디오 로드됨: ${Math.round(video.duration)}초`);
        };
        video.play().catch(err => log(`⚠ 재생 실패: ${err.message}`));
        
        recordToggleBtn.textContent = '녹화 시작';
        if (extractFramesBtn) extractFramesBtn.disabled = false;
      };
      
      mediaRecorder.start();
      recordToggleBtn.textContent = '녹화 중지';
    } else {
      mediaRecorder.stop();
      log('⏹️ 녹화 중지됨');
    }
  });
  log('🎙️ 녹화 리스너 등록됨');
} else {
  console.error('❌ recordToggleBtn 요소 없음!');
}

// ============================================================================
// FRAME EXTRACTION
// ============================================================================

if (extractFramesBtn) {
  extractFramesBtn.addEventListener('click', async () => {
    if (isExtracting) return;
    if (!video.src) {
      log('❌ 비디오 없음');
      return;
    }
    
    isExtracting = true;
    extractFramesBtn.disabled = true;
    extractProgress.style.display = '';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    extractedFrames = [];
    frameROIs = {};
    
    try {
      const fps = getFpsValue();
      const duration = video.duration;
      const totalFrames = Math.ceil(duration * fps);
      const dpr = window.devicePixelRatio || 1;
      const cssW = video.videoWidth || video.clientWidth || 640;
      const cssH = video.videoHeight || video.clientHeight || 360;
      
      log(`⏳ 추출 시작: ${totalFrames}프레임, ${fps}FPS`);
      
      for (let i = 0; i < totalFrames; i++) {
        const t = i / fps;
        video.currentTime = t;
        
        // 프레임 렌더링 대기
        await new Promise((res) => {
          let done = false;
          const onSeeked = () => { if (!done) { done = true; video.removeEventListener('seeked', onSeeked); res(); } };
          const timeout = setTimeout(() => { if (!done) { done = true; video.removeEventListener('seeked', onSeeked); res(); } }, 1000);
          video.addEventListener('seeked', onSeeked);
        });
        
        // 캔버스 생성 (DPR aware)
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas._cssWidth = cssW;
        canvas._cssHeight = cssH;
        canvas._dpr = dpr;
        
        const ctx = canvas.getContext('2d');
        try {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.drawImage(video, 0, 0, cssW, cssH);
        } catch (err) {
          console.warn('drawImage failed:', err);
          ctx.fillStyle = '#666';
          ctx.fillRect(0, 0, cssW, cssH);
        }
        
        extractedFrames.push(canvas);
        
        const percent = Math.round((i / totalFrames) * 100);
        progressBar.style.width = percent + '%';
        progressText.textContent = percent + '%';
        
        if (i % 10 === 0) log(`추출 중: ${i}/${totalFrames}`);
      }
      
      log(`✓ 추출 완료: ${extractedFrames.length}프레임`);
      extractProgress.style.display = 'none';
      
      // Tab 3로 이동 후 첫 프레임 표시
      const tab3 = document.getElementById('tab-3');
      const tab2 = document.getElementById('tab-2');
      if (tab2) tab2.style.display = 'none';
      if (tab3) tab3.style.display = '';
      
      await new Promise(r => requestAnimationFrame(r));
      await showFrame(0);
      
    } catch (err) {
      log(`❌ 추출 실패: ${err.message}`);
    } finally {
      isExtracting = false;
      extractFramesBtn.disabled = false;
    }
  });
  log('🎬 프레임 추출 리스너 등록됨');
} else {
  console.error('❌ extractFramesBtn 요소 없음!');
}

// ============================================================================
// FRAME DISPLAY
// ============================================================================

async function showFrame(idx) {
  if (!extractedFrames.length) return;
  currentFrameIndex = Math.max(0, Math.min(idx, extractedFrames.length - 1));
  const srcCanvas = extractedFrames[currentFrameIndex];
  
  const dpr = srcCanvas._dpr || window.devicePixelRatio || 1;
  const srcCssW = srcCanvas._cssWidth;
  const srcCssH = srcCanvas._cssHeight;
  const previewEl = document.getElementById('framePreview');
  const displayW = previewEl?.clientWidth || video?.clientWidth || overlay?.clientWidth || 640;
  const displayH = previewEl?.clientHeight || video?.clientHeight || overlay?.clientHeight || 360;
  
  // Overlay 설정
  overlay.width = Math.round(displayW * dpr);
  overlay.height = Math.round(displayH * dpr);
  overlay.style.width = displayW + 'px';
  overlay.style.height = displayH + 'px';
  
  const ctx = overlay.getContext('2d');
  try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { }
  ctx.clearRect(0, 0, displayW, displayH);
  
  // 이미지 그리기
  ctx.drawImage(srcCanvas, 0, 0, srcCssW, srcCssH, 0, 0, displayW, displayH);
  
  // Preview 업데이트
  if (previewEl) {
    previewEl.src = srcCanvas.toDataURL('image/png');
    previewEl.style.width = displayW + 'px';
    previewEl.style.height = displayH + 'px';
    previewEl.style.display = '';
  }
  
  if (frameIdxEl) frameIdxEl.textContent = `Frame ${currentFrameIndex + 1} / ${extractedFrames.length}`;
  console.log('[Traker] 프레임 표시:', currentFrameIndex);
}

if (prevFrameBtn) {
  prevFrameBtn.addEventListener('click', async () => {
    if (!extractedFrames.length) return;
    await showFrame(currentFrameIndex - 1);
    log('◀ 이전');
  });
}

if (nextFrameBtn) {
  nextFrameBtn.addEventListener('click', async () => {
    if (!extractedFrames.length) return;
    await showFrame(currentFrameIndex + 1);
    log('▶ 다음');
  });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

console.log('[Traker] 초기화 완료 ✓');
log('✓ 준비됨');
