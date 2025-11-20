/**
 * Motion Tracker App - Refactored
 * 
 * 핵심 목표:
 * 1. 명확한 DPR 처리: 모든 캔버스(캡처/오버레이/재생) 일관성 유지
 * 2. 프레임 표시 보장: extractFrames 완료 후 showFrame(0) 자동 호출
 * 3. ROI/박스 좌표 정렬: CSS 픽셀 기반 스케일로 미표시 제거
 * 4. 시각 디버그: 임시 테두리/로그로 가시성 확인
 * 5. 단순화된 로직: 불필요한 복잡도 제거
 */

// ============================================================================
// SECTION: DOM Elements & Global State
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
const selectROIBtn = document.getElementById('selectROI');
const completeROIsBtn = document.getElementById('completeROIs');
const runDetectBtn = document.getElementById('runDetect');
const stepAnalyzeBtn = document.getElementById('stepAnalyze');
const playResultsBtn = document.getElementById('playResultsBtn');
const exportCSVBtn = document.getElementById('exportCSV');
const modelFileInput = document.getElementById('modelFile');
const inspectModelBtn = document.getElementById('inspectModel');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const extractProgress = document.getElementById('extractProgress');
const tabContents = { 1: document.getElementById('tab-1'), 2: document.getElementById('tab-2'), 3: document.getElementById('tab-3'), 4: document.getElementById('tab-4') };

// Global state
let modelSession = null;
let modelLoaded = false;
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let extractedFrames = [];
let currentFrameIndex = 0;
let frameROIs = {};
let isExtracting = false;
let detectionsPerFrame = [];
let analysisResult = null;
let roi = null;
let selecting = false;
let startX, startY, curX, curY;
let lastNavTime = 0;
let activeFrameSaveListener = null;
let scalePxPerUnit = 1;
let posChart = null;
let velChart = null;

// Config
const DEFAULT_FPS = 10;
const DEFAULT_CONF_THRESHOLD = 0.3;
const DEBUG_MODE = true; // 시각 디버그 활성화

// ============================================================================
// SECTION: Utility Functions
// ============================================================================

function log(...args) {
  console.log('[Traker]', ...args);
  if (DEBUG_MODE) mobileLog(String(args[0]));
}

function warn(...args) {
  console.warn('[Traker]', ...args);
  mobileLog('⚠ ' + String(args[0]));
}

function error(...args) {
  console.error('[Traker]', ...args);
  mobileLog('❌ ' + String(args[0]));
}

function getFpsValue() {
  const el = document.querySelector('#tab-2 #fpsInput') || document.getElementById('fpsInput');
  return Number(el?.value) || DEFAULT_FPS;
}

function getConfValue() {
  const el = document.querySelector('#tab-2 #confInput') || document.getElementById('confInput');
  return Number(el?.value) || DEFAULT_CONF_THRESHOLD;
}

function getScaleValue() {
  const el = document.getElementById('scaleInput');
  return parseFloat(el?.value) || 1;
}

function switchTab(n) {
  [1, 2, 3, 4].forEach(i => {
    const tabEl = tabContents[i];
    if (tabEl) tabEl.style.display = i === n ? '' : 'none';
  });
}

function mobileLog(msg) {
  try {
    let el = document.getElementById('mobileStatusLog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mobileStatusLog';
      Object.assign(el.style, {
        position: 'fixed', left: '8px', right: '8px', bottom: '12px',
        padding: '8px 10px', background: 'rgba(0,0,0,0.7)', color: '#fff',
        fontSize: '11px', borderRadius: '6px', zIndex: '9999', maxHeight: '150px', overflow: 'auto'
      });
      document.body.appendChild(el);
    }
    const p = document.createElement('div');
    p.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    el.appendChild(p);
    if (el.childNodes.length > 8) el.removeChild(el.firstChild);
  } catch (e) { console.warn('mobileLog failed', e); }
}

function restoreVideoView() {
  try {
    const preview = document.getElementById('framePreview');
    if (preview) preview.style.display = 'none';
    if (video) video.style.display = '';
    if (overlay) overlay.style.display = '';
  } catch (e) { }
}

/**
 * DPR-aware canvas factory
 * Returns a canvas with internal pixels scaled by devicePixelRatio,
 * plus metadata for coordinate transformations.
 */
function createDPRCanvas(cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  canvas._cssWidth = cssWidth;
  canvas._cssHeight = cssHeight;
  canvas._dpr = dpr;
  const ctx = canvas.getContext('2d');
  try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { }
  return canvas;
}

/**
 * Draw image on DPR-aware canvas using CSS pixel coordinates
 */
function drawOnDPRCanvas(canvas, image, srcW, srcH, tgtW, tgtH) {
  const ctx = canvas.getContext('2d');
  try { ctx.setTransform(canvas._dpr || 1, 0, 0, canvas._dpr || 1, 0, 0); } catch (e) { }
  ctx.clearRect(0, 0, tgtW, tgtH);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, 0, 0, srcW, srcH, 0, 0, tgtW, tgtH);
}

// ============================================================================
// SECTION: Input Handlers
// ============================================================================

if (videoFile) {
  videoFile.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    video.src = url;
    video.play().catch(err => warn('play failed', err));
    if (extractFramesBtn) extractFramesBtn.disabled = false;
    log('비디오 파일 로드됨');
  });
}

if (startCameraBtn) {
  startCameraBtn.addEventListener('click', async () => {
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = currentStream;
      if (recordToggleBtn) recordToggleBtn.disabled = false;
      log('카메라 시작됨');
    } catch (err) {
      error('카메라 접근 실패', err);
      alert('카메라에 접근할 수 없습니다.');
    }
  });
}

if (recordToggleBtn) {
  recordToggleBtn.addEventListener('click', () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(currentStream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        video.src = URL.createObjectURL(blob);
        video.play().catch(err => warn('play failed', err));
        recordToggleBtn.textContent = '녹화 시작';
        if (extractFramesBtn) extractFramesBtn.disabled = false;
        log('녹화 완료, 비디오 로드됨');
      };
      mediaRecorder.start();
      recordToggleBtn.textContent = '녹화 중...';
      log('녹화 시작');
    } else {
      mediaRecorder.stop();
    }
  });
}

// ============================================================================
// SECTION: Frame Extraction
// ============================================================================

if (extractFramesBtn) {
  extractFramesBtn.addEventListener('click', async () => {
    if (isExtracting) { mobileLog('추출 중..'); return; }
    if (!video.src) { alert('비디오를 먼저 선택하세요.'); return; }
    
    isExtracting = true;
    extractFramesBtn.disabled = true;
    extractProgress.style.display = '';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    extractedFrames = [];
    frameROIs = {};
    currentFrameIndex = 0;
    log('프레임 추출 시작');

    try {
      const fps = getFpsValue() || DEFAULT_FPS;
      const duration = video.duration;
      if (duration <= 0) { alert('비디오 정보를 읽을 수 없습니다.'); return; }
      
      const totalFrames = Math.ceil(duration * fps);
      const dpr = window.devicePixelRatio || 1;
      const cssW = video.videoWidth || video.clientWidth || 640;
      const cssH = video.videoHeight || video.clientHeight || 360;

      log(`추출 시작: ${totalFrames}개 프레임, ${fps} FPS, 해상도 ${cssW}x${cssH} (DPR: ${dpr})`);

      for (let i = 0; i < totalFrames; i++) {
        const t = i / fps;
        await seekToTime(t, video);
        await new Promise(r => requestAnimationFrame(r)); // 렌더링 완료 대기

        const canvas = createDPRCanvas(cssW, cssH);
        const ctx = canvas.getContext('2d');
        try {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.drawImage(video, 0, 0, cssW, cssH);
        } catch (err) {
          warn(`프레임 ${i} 캡처 실패`, err);
          ctx.fillStyle = 'rgb(100,100,100)';
          ctx.fillRect(0, 0, cssW, cssH);
        }

        extractedFrames.push(canvas);
        const percent = Math.round((i / totalFrames) * 100);
        progressBar.style.width = percent + '%';
        progressText.textContent = percent + '%';
        mobileLog(`추출 중: ${i + 1}/${totalFrames}`);
      }

      extractProgress.style.display = 'none';
      if (stepROIBtn) stepROIBtn.disabled = false;
      if (stepAnalyzeBtn) stepAnalyzeBtn.disabled = false;
      log(`추출 완료: ${extractedFrames.length}개 프레임`);
      mobileLog(`✓ 추출 완료`);

      // 자동으로 tab-3으로 이동하고 첫 프레임 표시
      switchTab(3);
      await new Promise(r => requestAnimationFrame(r));
      await showFrame(0);
    } catch (err) {
      error('추출 중 오류', err);
      alert('추출 중 오류가 발생했습니다: ' + err.message);
    } finally {
      isExtracting = false;
      extractFramesBtn.disabled = false;
    }
  });
}

// ============================================================================
// SECTION: Frame Display & ROI Selection
// ============================================================================

async function showFrame(idx) {
  if (!extractedFrames.length) return;
  currentFrameIndex = Math.max(0, Math.min(idx, extractedFrames.length - 1));
  const srcCanvas = extractedFrames[currentFrameIndex];
  const dpr = srcCanvas._dpr || window.devicePixelRatio || 1;
  const srcCssW = srcCanvas._cssWidth;
  const srcCssH = srcCanvas._cssHeight;

  // 오버레이 크기 결정
  const previewEl = document.getElementById('framePreview');
  const displayW = (previewEl?.clientWidth) || (video?.clientWidth) || (overlay?.clientWidth) || 640;
  const displayH = (previewEl?.clientHeight) || (video?.clientHeight) || (overlay?.clientHeight) || 360;

  // 오버레이 DPI-aware 설정
  overlay.width = Math.max(1, Math.round(displayW * dpr));
  overlay.height = Math.max(1, Math.round(displayH * dpr));
  overlay.style.width = displayW + 'px';
  overlay.style.height = displayH + 'px';

  const ctx = overlay.getContext('2d');
  try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { }
  ctx.clearRect(0, 0, displayW, displayH);

  // 원본 이미지 그리기
  drawOnDPRCanvas(overlay, srcCanvas, srcCssW, srcCssH, displayW, displayH);

  // 프레임 미리보기 이미지 업데이트
  try {
    if (previewEl) {
      previewEl.src = srcCanvas.toDataURL('image/png');
      previewEl.style.width = displayW + 'px';
      previewEl.style.height = displayH + 'px';
      previewEl.style.display = '';
      previewEl.style.visibility = 'visible';
      if (DEBUG_MODE) previewEl.style.outline = '2px solid rgba(0,200,255,0.4)';
    }
  } catch (e) { warn('framePreview 업데이트 실패', e); }

  // ROI 그리기
  const roiObj = frameROIs[currentFrameIndex];
  if (roiObj) {
    const scaleX = displayW / srcCssW;
    const scaleY = displayH / srcCssH;
    const sx = roiObj.x * scaleX, sy = roiObj.y * scaleY, sw = roiObj.w * scaleX, sh = roiObj.h * scaleY;
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);
  }

  // 디버그 테두리
  if (DEBUG_MODE) {
    overlay.style.outline = '2px solid rgba(255,0,0,0.4)';
    setTimeout(() => {
      overlay.style.outline = '';
      if (previewEl) previewEl.style.outline = '';
    }, 1500);
  }

  if (frameIdxEl) frameIdxEl.textContent = `Frame ${currentFrameIndex + 1} / ${extractedFrames.length}`;
  log(`프레임 표시: ${currentFrameIndex}`);
}

if (prevFrameBtn) {
  prevFrameBtn.addEventListener('click', async (e) => {
    e?.preventDefault();
    if (!extractedFrames.length) return;
    const now = Date.now();
    if (now - lastNavTime < 250) return;
    lastNavTime = now;
    await showFrame(currentFrameIndex - 1);
    mobileLog('◀ 이전');
  });
}

if (nextFrameBtn) {
  nextFrameBtn.addEventListener('click', async (e) => {
    e?.preventDefault();
    if (!extractedFrames.length) return;
    const now = Date.now();
    if (now - lastNavTime < 250) return;
    lastNavTime = now;
    await showFrame(currentFrameIndex + 1);
    mobileLog('▶ 다음');
  });
}

// ============================================================================
// SECTION: ROI Selection
// ============================================================================

if (selectROIBtn) {
  selectROIBtn.addEventListener('click', () => {
    if (!extractedFrames.length) { alert('먼저 프레임을 추출하세요.'); return; }
    log('ROI 선택 모드 시작');
    mobileLog('ROI를 드래그하여 선택하세요');
    selecting = true;
    
    const handleStart = (e) => {
      const rect = overlay.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      startX = (e.clientX - rect.left) / dpr;
      startY = (e.clientY - rect.top) / dpr;
    };

    const handleMove = (e) => {
      if (!selecting) return;
      const rect = overlay.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      curX = (e.clientX - rect.left) / dpr;
      curY = (e.clientY - rect.top) / dpr;
      drawOverlay();
    };

    const handleEnd = async (e) => {
      if (!selecting) return;
      const rect = overlay.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const endX = (e.clientX - rect.left) / dpr;
      const endY = (e.clientY - rect.top) / dpr;
      roi = {
        x: Math.min(startX, endX),
        y: Math.min(startY, endY),
        w: Math.abs(endX - startX),
        h: Math.abs(endY - startY)
      };
      frameROIs[currentFrameIndex] = roi;
      selecting = false;
      overlay.removeEventListener('pointerdown', handleStart);
      overlay.removeEventListener('pointermove', handleMove);
      overlay.removeEventListener('pointerup', handleEnd);
      await showFrame(currentFrameIndex);
      log(`ROI 저장됨: Frame ${currentFrameIndex}`, roi);
      mobileLog('ROI 저장됨');
    };

    overlay.addEventListener('pointerdown', handleStart);
    overlay.addEventListener('pointermove', handleMove);
    overlay.addEventListener('pointerup', handleEnd);
  });
}

function drawOverlay() {
  if (!extractedFrames.length) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = overlay.getContext('2d');
  try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { }
  ctx.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr);

  // 현재 프레임 다시 그리기
  const srcCanvas = extractedFrames[currentFrameIndex];
  const displayW = overlay.width / dpr;
  const displayH = overlay.height / dpr;
  const srcCssW = srcCanvas._cssWidth;
  const srcCssH = srcCanvas._cssHeight;
  drawOnDPRCanvas(overlay, srcCanvas, srcCssW, srcCssH, displayW, displayH);

  // ROI 그리기
  if (roi && selecting) {
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(startX, curX), Math.min(startY, curY), Math.abs(curX - startX), Math.abs(curY - startY));
    ctx.setLineDash([]);
  }

  // 저장된 ROI 그리기
  const roiObj = frameROIs[currentFrameIndex];
  if (roiObj) {
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(roiObj.x, roiObj.y, roiObj.w, roiObj.h);
    ctx.setLineDash([]);
  }
}

// ============================================================================
// SECTION: Analysis & Detection
// ============================================================================

async function seekToTime(videoEl, t) {
  const src = videoEl || video;
  return new Promise((res) => {
    let done = false;
    const cleanup = () => {
      src.removeEventListener('seeked', onSeek);
      src.removeEventListener('timeupdate', onTime);
      if (src.requestVideoFrameCallback && vidRVCId) {
        try { cancelVideoFrameCallback(vidRVCId); } catch (e) { }
      }
      clearTimeout(timeoutId);
    };
    const onSeek = () => { if (!done) { done = true; cleanup(); res(); } };
    const onTime = () => { if (!done) { done = true; cleanup(); res(); } };
    let vidRVCId = null;
    if (src.requestVideoFrameCallback) {
      try {
        vidRVCId = src.requestVideoFrameCallback(() => {
          if (!done) { done = true; cleanup(); res(); }
        });
      } catch (e) { }
    }
    src.addEventListener('seeked', onSeek);
    src.addEventListener('timeupdate', onTime);
    try { src.currentTime = Math.min(src.duration, t); } catch (e) { }
    const timeoutId = setTimeout(() => {
      if (!done) { done = true; cleanup(); res(); }
    }, 3000);
  });
}

if (runDetectBtn) {
  runDetectBtn.addEventListener('click', async () => {
    if (!roi) { alert('먼저 ROI를 선택하세요.'); return; }
    log('분석 시작');
    await analyzeByROI();
    switchTab(4);
  });
}

async function analyzeByROI() {
  if (!roi) { alert('ROI를 먼저 선택하세요.'); return; }
  detectionsPerFrame = [];
  const fps = getFpsValue() || DEFAULT_FPS;
  const duration = video.duration || 0;
  const totalFrames = Math.floor(duration * fps);

  for (let i = 0; i < totalFrames; i++) {
    await seekToTime(video, i / fps);
    const vbox = roiToVideoBox(roi);
    const cx = vbox.x + vbox.w / 2;
    const cy = vbox.y + vbox.h / 2;
    detectionsPerFrame.push({ time: video.currentTime, box: [vbox.x, vbox.y, vbox.x + vbox.w, vbox.y + vbox.h], score: 1.0 });
  }

  analyzeTrackData();
}

function roiToVideoBox(roiOverlay) {
  const vr = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: 0, h: 0 };
  const scaleX = vw / vr.width;
  const scaleY = vh / vr.height;
  return { x: roiOverlay.x * scaleX, y: roiOverlay.y * scaleY, w: roiOverlay.w * scaleX, h: roiOverlay.h * scaleY };
}

function analyzeTrackData() {
  const points = [];
  for (const f of detectionsPerFrame) {
    if (f.box) {
      const [x1, y1, x2, y2] = f.box;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      points.push({ t: f.time, x: cx, y: cy });
    } else {
      points.push({ t: f.time, x: null, y: null });
    }
  }

  const speeds = [];
  const accs = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0) { speeds.push(null); accs.push(null); continue; }
    const p0 = points[i - 1];
    const p1 = points[i];
    if (p0.x === null || p1.x === null) { speeds.push(null); accs.push(null); continue; }
    const dt = (p1.t - p0.t) || (1 / DEFAULT_FPS);
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const distPx = Math.hypot(dx, dy);
    const speed = (distPx / dt) / scalePxPerUnit;
    speeds.push(speed);
    if (i === 1) { accs.push(null); continue; }
    const prevSpeed = speeds[i - 1] || 0;
    const acc = (speed - prevSpeed) / dt;
    accs.push(acc);
  }

  drawCharts(points, speeds);
  analysisResult = { points, speeds, accs };
  log('분석 완료');
  mobileLog('✓ 분석 완료');
}

function drawCharts(points, speeds) {
  const labels = points.map(p => p.t.toFixed(2));
  const xs = points.map(p => p.x ? p.x / scalePxPerUnit : null);
  const ys = points.map(p => p.y ? p.y / scalePxPerUnit : null);
  const speedData = speeds.map(s => s || 0);

  if (posChart) posChart.destroy();
  const posCtx = document.getElementById('posChart')?.getContext('2d');
  if (posCtx) {
    posChart = new Chart(posCtx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'X (units)', data: xs, borderColor: '#4fd1c5', tension: 0.2, spanGaps: true },
          { label: 'Y (units)', data: ys, borderColor: '#f97316', tension: 0.2, spanGaps: true }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  if (velChart) velChart.destroy();
  const velCtx = document.getElementById('velChart')?.getContext('2d');
  if (velCtx) {
    velChart = new Chart(velCtx, {
      type: 'line',
      data: {
        labels,
        datasets: [{ label: 'Speed (units/s)', data: speedData, borderColor: '#60a5fa', tension: 0.2, spanGaps: true }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }
}

if (exportCSVBtn) {
  exportCSVBtn.addEventListener('click', () => {
    if (!analysisResult) { alert('분석 후 내보내기 하세요.'); return; }
    const rows = [['frame', 'time_s', 'x_px', 'y_px', 'x_unit', 'y_unit', 'speed_unit_s', 'acc_unit_s2']];
    for (let i = 0; i < detectionsPerFrame.length; i++) {
      const d = detectionsPerFrame[i];
      const a = analysisResult.points[i];
      const s = analysisResult.speeds[i] || '';
      const acc = analysisResult.accs[i] || '';
      const x_px = a.x || '';
      const y_px = a.y || '';
      const x_u = a.x ? (a.x / scalePxPerUnit).toFixed(4) : '';
      const y_u = a.y ? (a.y / scalePxPerUnit).toFixed(4) : '';
      rows.push([i, (d.time || 0).toFixed(4), x_px, y_px, x_u, y_u, s, acc]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'analysis.csv';
    a.click();
    URL.revokeObjectURL(url);
    log('CSV 내보내기 완료');
  });
}

// ============================================================================
// SECTION: Model Loading (Placeholder)
// ============================================================================

async function loadModel() {
  log('모델 로드 시도 중...');
  // TODO: YOLO 모델 로드 로직 (현재는 ROI 기반 분석만 지원)
}

if (inspectModelBtn) {
  inspectModelBtn.addEventListener('click', () => {
    alert('모델 로드 기능은 추후 구현됩니다.');
  });
}

// ============================================================================
// SECTION: Initialization
// ============================================================================

log('앱 초기화 완료');
switchTab(1);
if (extractFramesBtn) extractFramesBtn.disabled = true;
if (stepROIBtn) stepROIBtn.disabled = true;
if (stepAnalyzeBtn) stepAnalyzeBtn.disabled = true;
