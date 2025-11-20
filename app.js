// Motion Tracker main app.js - 안정화 버전
/*
  Motion Tracker — 안정화된 최소 동작 버전
  목표:
   - 파일 업로드 후 비디오가 화면에 보이도록 보장
   - 프레임 추출(seek 기반)을 안정적으로 수행
   - 추출된 프레임을 overlay/preview에 표시
  이 파일은 복잡한 분석(YOLO 등)을 보조하는 기존 코드에서 업로드/추출/표시 경로를 단순화하여
  문제를 해결하는 데 집중합니다.
*/

const $ = id => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const framePreview = $('framePreview');

// Ensure commonly used globals exist with safe defaults (prevents ReferenceErrors)
let modelSession = null;
let modelLoaded = false;
let detectionsPerFrame = [];
let frameROIs = [];
let roi = null;
let posChart = null;
let velChart = null;
let scalePxPerUnit = 100; // px per unit default (user can override in UI)
let lastNavTime = 0;

// Minimal bindMulti fallback if not provided elsewhere. Adds basic click + pointer support and optional cooldown.
function bindMulti(el, handler, cooldownMs){
  if(!el) return;
  let last = 0;
  const wrapper = function(e){
    const now = Date.now();
    if(cooldownMs && now - last < cooldownMs) return;
    last = now;
    try{ handler(e); }catch(err){ console.warn('bindMulti handler error', err); }
  };
  el.addEventListener('click', wrapper);
  el.addEventListener('pointerdown', wrapper);
}

// Make video element autoplay-friendly and visible when available
if(video){
  try{ video.playsInline = true; video.muted = true; video.controls = true; video.style.display = video.style.display || 'block'; }catch(e){}
}

// Controls
const videoFile = $('videoFile');
const startCameraBtn = $('startCamera');
const recordToggleBtn = $('recordToggle');
const extractFramesBtn = $('extractFramesBtn');
const prevFrameBtn = $('prevFrame');
const nextFrameBtn = $('nextFrame');
const frameIdxEl = $('frameIdx');
const extractProgress = $('extractProgress');
const progressBar = $('progressBar');
const progressText = $('progressText');

// Small on-screen status (for users without console access)
function userLog(msg){
  console.log('[Traker]', msg);
  try{
    let el = document.getElementById('mobileStatusLog');
    if(!el){
      el = document.createElement('div'); el.id = 'mobileStatusLog';
      Object.assign(el.style, {position:'fixed',left:'8px',right:'8px',bottom:'12px',padding:'8px 10px',background:'rgba(0,0,0,0.7)',color:'#fff',fontSize:'12px',zIndex:9999,maxHeight:'140px',overflow:'auto'});
      document.body.appendChild(el);
    }
    const p = document.createElement('div'); p.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    el.appendChild(p);
    while(el.childNodes.length>6) el.removeChild(el.firstChild);
  }catch(e){}
}

// State
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let extractedFrames = []; // canvases
let currentFrameIndex = 0;

// helpers
function safe(el, name){ if(!el) userLog(`요소 없음: ${name}`); return !!el; }
function setProgress(p){ if(progressBar) progressBar.style.width = `${p}%`; if(progressText) progressText.textContent = `${p}%`; }

// Resize overlay to visible video area and handle DPR
function resizeOverlay(){
  if(!overlay || !video) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(video.clientWidth * dpr));
  const h = Math.max(1, Math.round(video.clientHeight * dpr));
  overlay.width = w; overlay.height = h;
  overlay.style.width = video.clientWidth + 'px';
  overlay.style.height = video.clientHeight + 'px';
}
window.addEventListener('resize', resizeOverlay);
video && video.addEventListener('loadedmetadata', ()=>{ resizeOverlay(); });

// -------------------------
// File upload handling
// -------------------------
if(videoFile){
  videoFile.addEventListener('change', async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f){ userLog('파일 선택 취소'); return; }
    userLog(`파일 선택: ${f.name}`);

    try{
      // Stop any camera stream to avoid srcObject conflicts
      if(currentStream){
        try{ currentStream.getTracks().forEach(t=>t.stop()); }catch(e){}
        currentStream = null; video.srcObject = null;
      }

      // If mediaRecorder recording, stop it
      if(mediaRecorder && mediaRecorder.state === 'recording'){ mediaRecorder.stop(); }

      const url = URL.createObjectURL(f);
      // prefer setting srcObject to null first
      if(video){
        video.srcObject = null;
        video.src = url;
        // make sure video is visible/controls enabled
        try{ video.style.display = video.style.display || 'block'; video.playsInline = true; video.muted = false; video.controls = true; }catch(e){}
        console.log('[Traker] set video.src ->', url);
      }

      // Wait for metadata to be ready (or fallback after timeout)
      await new Promise((res,rej)=>{
        if(!video){ return res(); }
        const t = setTimeout(()=>{ console.warn('[Traker] loadedmetadata timeout'); res(); }, 3000);
        function onMeta(){ clearTimeout(t); video.removeEventListener('loadedmetadata', onMeta); res(); }
        video.addEventListener('loadedmetadata', onMeta, {once:true});
      });

      // Log state and attempt play (may be blocked by browser autoplay policies)
      try{
        userLog(`비디오 로드 완료: ${Math.round(video.duration||0)}초, ${video.videoWidth}x${video.videoHeight}`);
        console.log('[Traker] video readyState, duration, src:', video.readyState, video.duration, video.currentSrc || video.src);
        await video.play();
        console.log('[Traker] video.play() succeeded');
      }catch(e){ userLog('자동 재생 실패(사용자 상호작용 필요)'); console.warn('video.play error', e); }

      // enable extract button
      if(extractFramesBtn) { extractFramesBtn.disabled = false; }
    }catch(err){
      userLog('파일 처리 중 오류: ' + (err && err.message));
    }
  });
} else { userLog('videoFile 입력이 없음'); }

// -------------------------
// Camera handling (simple)
// -------------------------
if(startCameraBtn){
  startCameraBtn.addEventListener('click', async ()=>{
    try{
      const s = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}, audio:false});
      currentStream = s; video.srcObject = s; video.muted = true;
      try{ video.playsInline = true; video.controls = false; await video.play(); }catch(e){ console.warn('camera video.play failed', e); }
      userLog('카메라 스트림 재생 중');
      console.log('[Traker] camera stream tracks:', s.getTracks().map(t=>t.kind+':'+t.readyState));
      if(recordToggleBtn){ recordToggleBtn.style.display = ''; recordToggleBtn.disabled = false; }
    }catch(err){ userLog('카메라 접근 실패: '+ err.message); alert('카메라 접근 실패: '+err.message); }
  });
}

// -------------------------
// Recording toggle (optional)
// -------------------------
if(recordToggleBtn){
  recordToggleBtn.addEventListener('click', ()=>{
    if(!currentStream){ userLog('카메라가 활성화되어 있지 않습니다'); return; }
    if(!mediaRecorder || mediaRecorder.state === 'inactive'){
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(currentStream);
      mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size) recordedChunks.push(e.data); };
      mediaRecorder.onstop = ()=>{
        const blob = new Blob(recordedChunks, {type:'video/webm'});
        const url = URL.createObjectURL(blob);
        video.srcObject = null; video.src = url; video.muted = false; video.play().catch(()=>{});
        userLog('녹화 완료, 재생으로 전환');
        if(extractFramesBtn) extractFramesBtn.disabled = false;
      };
      mediaRecorder.start(); recordToggleBtn.textContent = '녹화 중지';
      userLog('녹화 시작');
    } else {
      mediaRecorder.stop(); recordToggleBtn.textContent = '녹화 시작'; userLog('녹화 중지');
    }
  });
}

// -------------------------
// Frame extraction (seek-based, robust)
// -------------------------
async function extractFrames(){
  if(isExtracting) { userLog('이미 추출 중입니다'); return; }
  if(!video || (!video.currentSrc && !video.src)) { userLog('추출할 비디오가 없습니다'); return; }
  // determine source URL
  const srcUrl = video.currentSrc || video.src;
  if(!srcUrl){ userLog('비디오 소스 없음'); return; }

  isExtracting = true; extractedFrames = []; currentFrameIndex = 0;
  extractProgress && (extractProgress.style.display = ''); setProgress(0);

  try{
    // create a hidden capture video element to avoid interfering with UI playback
    const cap = document.createElement('video');
    cap.muted = true; cap.preload = 'auto'; cap.crossOrigin = 'anonymous';
    cap.src = srcUrl;
    // wait loadedmetadata
    await new Promise((res,rej)=>{
      const to = setTimeout(()=>{ res(); }, 4000);
      cap.addEventListener('loadedmetadata', ()=>{ clearTimeout(to); res(); }, {once:true});
    });
    const fpsInput = document.querySelector('#tab-2 #fpsInput') || $('fpsInput');
    const fps = Math.max(1, Number(fpsInput && fpsInput.value) || 10);
    const duration = cap.duration || video.duration || 0;
    const total = Math.max(1, Math.floor(duration * fps));
    userLog(`프레임 추출: duration=${duration.toFixed(2)}s, fps=${fps}, total=${total}`);

    const dpr = window.devicePixelRatio || 1;
    const cssW = cap.videoWidth || 640; const cssH = cap.videoHeight || 360;

    for(let i=0;i<total;i++){
      const t = Math.min(duration, (i / fps));
      // seek
      await new Promise((res)=>{
        let done = false;
        function onSeek(){ if(done) return; done = true; cap.removeEventListener('seeked', onSeek); res(); }
        cap.currentTime = t;
        cap.addEventListener('seeked', onSeek);
        // safety timeout
        setTimeout(()=>{ if(!done){ done = true; cap.removeEventListener('seeked', onSeek); res(); } }, 1200);
      });

      // draw to canvas
      const c = document.createElement('canvas');
      c._cssWidth = cssW; c._cssHeight = cssH; c._dpr = dpr;
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
      const ctx = c.getContext('2d');
      try{ ctx.setTransform(dpr,0,0,dpr,0,0); ctx.drawImage(cap, 0, 0, cssW, cssH); }
      catch(e){ ctx.fillStyle = '#333'; ctx.fillRect(0,0,cssW,cssH); }

      extractedFrames.push(c);
      const percent = Math.round(((i+1)/total) * 100);
      setProgress(percent);
      if(i % Math.max(1, Math.floor(total/10)) === 0) userLog(`추출 진행: ${i+1}/${total}`);
    }

    userLog(`프레임 추출 완료: ${extractedFrames.length}개`);
    extractProgress && (extractProgress.style.display = 'none'); setProgress(100);

    // show first frame
    await showFrame(0);
    // make nav visible
    document.querySelectorAll('.frame-nav').forEach(el=>el.style.display='flex');
  }catch(err){ userLog('프레임 추출 오류: ' + (err && err.message)); }
  finally{ isExtracting = false; extractFramesBtn && (extractFramesBtn.disabled = false); }
}

let isExtracting = false; // guard
if(extractFramesBtn) extractFramesBtn.addEventListener('click', ()=>{ extractFramesBtn.disabled = true; extractFrames(); });



// quick initialization logs
userLog('앱 초기화 완료 — 업로드→표시→추출 경로가 활성화되었습니다.');



// Frame navigation and per-frame ROI selection
async function showFrame(idx){
  if(!extractedFrames || !extractedFrames.length) return;
  currentFrameIndex = Math.max(0, Math.min(idx, extractedFrames.length-1));
  const c = extractedFrames[currentFrameIndex];
  // Quick visual debug aid and timing guard
  const DBG = (typeof window._TRAKER_DEBUG === 'undefined') ? true : window._TRAKER_DEBUG;
  if(DBG) console.log('showFrame start', {idx:currentFrameIndex, extractedCanvasW:c.width, extractedCanvasH:c.height, cssMeta: {cssW:c._cssWidth, cssH:c._cssHeight, dpr:c._dpr}});
  // wait one frame to ensure any pending layout/paint is done (helps mobile browsers)
  try{ await new Promise(r => requestAnimationFrame(r)); }catch(e){}
  // draw frame into overlay sized to the visible video area (DPI-aware)
  // Prefer preview image size when present (we hide the video element after extraction)
  const previewEl = document.getElementById('framePreview');
  const displayW = (previewEl && previewEl.clientWidth) || video.clientWidth || overlay.clientWidth || 640;
  const displayH = (previewEl && previewEl.clientHeight) || video.clientHeight || overlay.clientHeight || 360;
  const dpr = window.devicePixelRatio || 1;

  // Set canvas internal pixel size to CSS size * devicePixelRatio, but keep CSS size unchanged
  overlay.width = Math.max(1, Math.round(displayW * dpr));
  overlay.height = Math.max(1, Math.round(displayH * dpr));
  overlay.style.width = displayW + 'px';
  overlay.style.height = displayH + 'px';

  const drawCtx = overlay.getContext('2d');
  // Reset any transform then scale to DPR so drawing commands use CSS pixels
  try{ drawCtx.setTransform(1,0,0,1,0,0); }catch(e){}
  drawCtx.clearRect(0,0,overlay.width,overlay.height);
  drawCtx.setTransform(dpr,0,0,dpr,0,0);

  // Determine the source canvas CSS dimensions (captureFrameImage sets _cssWidth/_cssHeight)
  const srcCssW = c._cssWidth || Math.round((c.width || displayW) / dpr);
  const srcCssH = c._cssHeight || Math.round((c.height || displayH) / dpr);
  // scale image to overlay CSS size (context is already scaled by DPR)
  const scaleX = displayW / (srcCssW || displayW);
  const scaleY = displayH / (srcCssH || displayH);
  drawCtx.imageSmoothingEnabled = true;
  try{
    drawCtx.drawImage(c, 0,0, c.width, c.height, 0,0, displayW, displayH);
  }catch(e){
    console.warn('showFrame drawImage failed', e, 'canvas:', c.width, c.height, 'display:', displayW, displayH);
  }
  if(DBG){
    try{ overlay.style.visibility = 'visible'; overlay.style.outline = '2px solid rgba(255,0,0,0.45)'; }catch(e){}
    try{ const prev = document.getElementById('framePreview'); if(prev){ prev.style.visibility='visible'; prev.style.outline='2px solid rgba(0,200,255,0.45)'; } }catch(e){}
    setTimeout(()=>{ try{ overlay.style.outline=''; const prev = document.getElementById('framePreview'); if(prev) prev.style.outline=''; }catch(e){} }, 1500);
  }
  // if ROI exists for this frame, draw it
  const roiObj = frameROIs[currentFrameIndex];
  if(roiObj){
    // scale stored ROI (stored in original canvas coords) to overlay display (use CSS pixel scales)
    const sx = roiObj.x * scaleX;
    const sy = roiObj.y * scaleY;
    const sw = roiObj.w * scaleX;
    const sh = roiObj.h * scaleY;
    drawCtx.strokeStyle='#00ff88'; drawCtx.lineWidth=2; drawCtx.setLineDash([6,4]); drawCtx.strokeRect(sx, sy, sw, sh);
    drawCtx.setLineDash([]);
  }
  // update index label
  if(frameIdxEl) frameIdxEl.textContent = `Frame ${currentFrameIndex+1} / ${extractedFrames.length}`;
  // Also update the dedicated preview <img> if present to avoid overlay interaction issues
  try{
    const prev = document.getElementById('framePreview');
    if(prev){
      // Use the canvas dataURL; set CSS size to display pixels so it visually matches overlay
      prev.src = c.toDataURL('image/png');
      prev.style.width = displayW + 'px';
      prev.style.height = displayH + 'px';
      prev.style.objectFit = prev.style.objectFit || 'contain';
      prev.style.display = '';
      prev.style.visibility = 'visible';
      try{ overlay.style.visibility = 'visible'; }catch(e){}
    }
  }catch(e){ console.warn('failed to update framePreview', e); }
}

// Rebind prev/next with navigation guards: prevent multi-step jumps and stop propagation
if(prevFrameBtn){
  bindMulti(prevFrameBtn, (e)=>{
    if(e && e.preventDefault) e.preventDefault(); if(e && e.stopPropagation) e.stopPropagation();
    mobileLog('◀ 클릭'); console.log('prevFrame clicked, current', currentFrameIndex);
    if(!extractedFrames || !extractedFrames.length){ mobileLog('이동할 프레임이 없습니다'); return; }
    const now = Date.now(); if(now - lastNavTime < 250){ mobileLog('네비게이션 쿨다운 중'); return; }
    lastNavTime = now;
    const nextIdx = Math.max(0, currentFrameIndex - 1);
    showFrame(nextIdx);
  }, 300);
}
if(nextFrameBtn){
  bindMulti(nextFrameBtn, (e)=>{
    if(e && e.preventDefault) e.preventDefault(); if(e && e.stopPropagation) e.stopPropagation();
    mobileLog('▶ 클릭'); console.log('nextFrame clicked, current', currentFrameIndex);
    if(!extractedFrames || !extractedFrames.length){ mobileLog('이동할 프레임이 없습니다'); return; }
    const now = Date.now(); if(now - lastNavTime < 250){ mobileLog('네비게이션 쿨다운 중'); return; }
    lastNavTime = now;
    const nextIdx = Math.min(extractedFrames.length - 1, currentFrameIndex + 1);
    showFrame(nextIdx);
  }, 300);
}

// extractFramesBtn binding is handled by bindExtractButton() above which supports click/pointer/touch events

// complete ROIs button triggers analysis (stepAnalyzeBtn handler)
if(completeROIsBtn){ bindMulti(completeROIsBtn, (e)=>{ if(e && e.preventDefault) e.preventDefault(); switchTab(4); if(stepAnalyzeBtn) stepAnalyzeBtn.click(); }); }

if(playResultsBtn){ bindMulti(playResultsBtn, (e)=>{ if(e && e.preventDefault) e.preventDefault(); playResults(); switchTab(4); }); }

function drawOverlay(){
  // Ensure context is DPR-aware and drawing uses CSS pixel coordinates
  const dpr = window.devicePixelRatio || 1;
  const _ctx = overlay.getContext('2d');
  try{ _ctx.setTransform(1,0,0,1,0,0); }catch(e){}
  _ctx.clearRect(0,0,overlay.width,overlay.height);
  _ctx.setTransform(dpr,0,0,dpr,0,0);

  if(roi){
    _ctx.strokeStyle = '#00ff88'; _ctx.lineWidth = 2; _ctx.setLineDash([6,4]);
    _ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
    _ctx.setLineDash([]);
  }
  // draw latest detection for current frame if any
  const last = detectionsPerFrame.length ? detectionsPerFrame[detectionsPerFrame.length-1] : null;
  if(last && last.box){
    _ctx.strokeStyle = '#ff0066'; _ctx.lineWidth = 2;
    const [x1,y1,x2,y2] = mapBoxToOverlay(last.box);
    _ctx.strokeRect(x1,y1,x2-x1,y2-y1);
  }
}

function mapBoxToOverlay(box){
  // box coordinates stored in video pixel space (video width/height), convert to overlay pixels
  const videoRect = video.getBoundingClientRect();
  const vw = video.videoWidth; const vh = video.videoHeight;
  if(!vw||!vh) return [0,0,0,0];
  const scaleX = videoRect.width / vw;
  const scaleY = videoRect.height / vh;
  const [x1,y1,x2,y2] = box;
  return [x1*scaleX, y1*scaleY, x2*scaleX, y2*scaleY];
}

async function loadModel(){
  // Try several common locations (useful for GitHub Pages where repo path may vary)
  const candidatePaths = [
    './yolov8n.onnx',
    './model/yolov8n.onnx',
    '/yolov8n.onnx',
    '/model/yolov8n.onnx'
  ];
  const opts = {executionProviders:['wasm','webgl']};
  const statusEl = document.getElementById('status');
  if(statusEl) statusEl.textContent = '모델 로드 상태: 로딩 시도 중...';
  let lastErr = null;
  for(const p of candidatePaths){
    try{
      const url = p;
      console.log('시도중인 모델 경로:', url);
      const resp = await fetch(url, {method:'GET'});
      if(!resp.ok){
        console.warn('경로에서 모델을 찾지 못함', url, resp.status);
        lastErr = new Error('HTTP '+resp.status);
        continue;
      }
      const arrayBuffer = await resp.arrayBuffer();
      modelSession = await ort.InferenceSession.create(arrayBuffer, opts);
      modelLoaded = true;
      console.log('Model loaded from', url);
      console.log('Model input names:', modelSession.inputNames, 'output names:', modelSession.outputNames);
  if(statusEl) statusEl.textContent = `모델 로드 상태: 성공 (${url})`;
  // enable inspect button (model-dependent). keep runDetectBtn enabled for ROI fallback.
  if(inspectModelBtn) inspectModelBtn.disabled = false;
      return;
    }catch(err){
      console.warn('모델 로드 실패 경로:', p, err);
      lastErr = err;
      continue;
    }
  }
  // If we reach here, none of the candidate paths worked
  modelLoaded = false;
  if(statusEl) statusEl.innerHTML = '모델 로드 상태: 실패 — yolov8n.onnx 파일을 프로젝트 루트에 업로드하세요. (예: GitHub Pages의 경우 repo root 또는 docs/에 업로드)';
  // disable model-only UI (inspect), but keep runDetect available for manual ROI analysis
  if(inspectModelBtn) inspectModelBtn.disabled = true;
  console.error('모델을 찾지 못했습니다. 마지막 오류:', lastErr);
}

// Try to load model at startup (non-blocking)
loadModel();

// Allow user to upload a model file to avoid CORS/server issues
if(modelFileInput){
  modelFileInput.addEventListener('change', async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    try{
      const ab = await f.arrayBuffer();
      const opts = {executionProviders:['wasm','webgl']};
      modelSession = await ort.InferenceSession.create(ab, opts);
      modelLoaded = true;
      alert('업로드한 모델을 성공적으로 로드했습니다.');
    }catch(err){
      console.error('업로드한 모델 로드 실패', err);
      modelLoaded = false;
      alert('업로드한 모델을 로드하지 못했습니다. 파일이 올바른 ONNX인지 확인하세요.');
    }
  });
}

// Inspect model: run a single dry-run inference with a zero tensor and print outputs
if(inspectModelBtn){
  inspectModelBtn.addEventListener('click', async ()=>{
    if(!modelLoaded || !modelSession){
      alert('모델이 로드되어 있지 않습니다. 먼저 모델을 업로드하거나 서버에서 로드하세요.');
      return;
    }
    try{
      const inputName = modelSession.inputNames[0];
      // Create a zero tensor matching a common input shape [1,3,640,640]
      const size = 640;
      const tensorSize = 1*3*size*size;
      const zeros = new Float32Array(tensorSize);
      const testTensor = new ort.Tensor('float32', zeros, [1,3,size,size]);
      const feeds = {};
      feeds[inputName] = testTensor;
      console.log('Running dry-run inference (zero tensor) on input:', inputName);
      const out = await modelSession.run(feeds);
      console.log('Dry-run outputs:');
      for(const k of Object.keys(out)){
        const t = out[k];
        console.log('Output name:', k, 'shape:', t.dims, 'type:', t.type);
        // print small sample
        try{ console.log('Sample values (first 60):', Array.from(t.data).slice(0,60)); }catch(e){ console.log('Cannot read sample values for', k, e); }
      }
      // Try parsing the first output through our parser (if suitable)
      const firstOutName = modelSession.outputNames && modelSession.outputNames[0];
      if(firstOutName && out[firstOutName]){
    const parsed = parseYoloOutput(out[firstOutName], {dx:0,dy:0,scale:1}, getConfValue()||0.1);
        console.log('Parsed detections sample (first 20):', parsed.slice(0,20));
      }
      alert('모델 검사가 완료되었습니다. 콘솔(개발자 도구)을 확인하세요.');
    }catch(err){
      console.error('Inspect model failed', err);
      alert('모델 검사 중 오류가 발생했습니다. 콘솔을 확인하세요.');
    }
  });
}

  // Step analyze: run YOLO on frames without ROI and assemble results
  if(stepAnalyzeBtn){
    stepAnalyzeBtn.addEventListener('click', async ()=>{
      // switch to results tab when analysis starts
      try{ switchTab(4); }catch(e){}
      if(!extractedFrames || !extractedFrames.length){ alert('프레임이 없습니다. 먼저 프레임을 추출하세요.'); return; }
      // For frames without ROI, run YOLO if available
  const confTh = getConfValue();
      const resultsPerFrame = [];
      for(let i=0;i<extractedFrames.length;i++){
        const roiObj = frameROIs[i];
        if(roiObj){
          // use centroid of ROI
          const cx = roiObj.x + roiObj.w/2; const cy = roiObj.y + roiObj.h/2;
          resultsPerFrame.push({box:[roiObj.x, roiObj.y, roiObj.x+roiObj.w, roiObj.y+roiObj.h], score:1.0, cx, cy});
        }else{
          // run YOLO on this frame if model loaded
          if(modelLoaded && modelSession){
            // prepare tensor from extractedFrames[i]
            const {tensor, padInfo} = preprocessForYOLO(extractedFrames[i], 640);
            const feeds = {}; feeds[modelSession.inputNames[0]] = tensor;
            try{
              const out = await modelSession.run(feeds);
              const outName = modelSession.outputNames[0];
              const parsed = parseYoloOutput(out[outName], padInfo, confTh);
              if(parsed && parsed.length){ const d = parsed[0]; const [x1,y1,x2,y2] = d.box; const cx=(x1+x2)/2; const cy=(y1+y2)/2; resultsPerFrame.push({box:d.box, score:d.score, cx, cy}); }
              else resultsPerFrame.push(null);
            }catch(err){ console.error('frame inference failed', err); resultsPerFrame.push(null); }
          }else{ resultsPerFrame.push(null); }
        }
      }
      // prepare analysis points for charts
  detectionsPerFrame = resultsPerFrame.map((r,idx)=>{ return r ? {time: idx / getFpsValue(), box:r.box, score:r.score} : {time: idx / getFpsValue(), box:null, score:0}; });
      analyzeTrackData();
      // enable playback step: draw result frames to canvas and play
      playResults();
    });
  }

  // Basic playback of result frames on overlay canvas
  let playTimer = null;
  function playResults(){
    if(!extractedFrames || !extractedFrames.length) return;
  let idx = 0; const total = extractedFrames.length; const fps = getFpsValue()||10;
    if(playTimer) clearInterval(playTimer);
    playTimer = setInterval(()=>{
      const c = extractedFrames[idx];
      const displayW = video.clientWidth || overlay.clientWidth || 640;
      const displayH = video.clientHeight || overlay.clientHeight || 360;
      const dpr = window.devicePixelRatio || 1;

      overlay.width = Math.max(1, Math.round(displayW * dpr));
      overlay.height = Math.max(1, Math.round(displayH * dpr));
      overlay.style.width = displayW + 'px'; overlay.style.height = displayH + 'px';

      const drawCtx = overlay.getContext('2d');
      try{ drawCtx.setTransform(1,0,0,1,0,0); }catch(e){}
      drawCtx.clearRect(0,0,overlay.width,overlay.height);
      drawCtx.setTransform(dpr,0,0,dpr,0,0);

      try{ drawCtx.drawImage(c,0,0, c.width, c.height, 0,0, displayW, displayH); }catch(e){ console.warn('playResults drawImage failed', e); }
      const det = detectionsPerFrame[idx];
      if(det && det.box){
        const [x1,y1,x2,y2] = det.box;
        const srcCssW = c._cssWidth || Math.round((c.width || displayW) / dpr);
        const srcCssH = c._cssHeight || Math.round((c.height || displayH) / dpr);
        const scaleX = displayW / (srcCssW || displayW);
        const scaleY = displayH / (srcCssH || displayH);
        const sx = x1 * scaleX, sy = y1 * scaleY, sw = (x2-x1) * scaleX, sh = (y2-y1) * scaleY;
        drawCtx.strokeStyle='#ff0066'; drawCtx.lineWidth=3; drawCtx.strokeRect(sx,sy,sw,sh);
      }
      idx++; if(idx>=total) idx=0;
    }, 1000 / fps);
  }

if(runDetectBtn) bindMulti(runDetectBtn, async (e)=>{
  if(e && e.preventDefault) e.preventDefault();
  if(!modelLoaded){
    if(!confirm('YOLO 모델이 로드되지 않았습니다. 계속해서 ROI 기반 수동 분석을 수행하시겠습니까?')) return;
    analyzeByROI();
  }else{
    await analyzeWithYOLO();
  }
});

async function analyzeByROI(){
  // Simple analysis: take centroid of ROI for each sampled frame
  if(!roi){ alert('분석할 ROI를 먼저 선택하세요'); return; }
  detectionsPerFrame = [];
  const fps = getFpsValue() || 30;
  const duration = video.duration || 0;
  const totalFrames = Math.floor(duration*fps);
  for(let i=0;i<totalFrames;i++){
    await seekToTime(i/fps);
    const vbox = roiToVideoBox(roi);
    const cx = vbox.x + vbox.w/2; const cy = vbox.y + vbox.h/2;
    detectionsPerFrame.push({time: video.currentTime, box:[vbox.x, vbox.y, vbox.x+vbox.w, vbox.y+vbox.h], score:1.0});
  }
  analyzeTrackData();
}

function roiToVideoBox(roiOverlay){
  // convert overlay roi to video pixel coords
  const vr = video.getBoundingClientRect();
  const vw = video.videoWidth; const vh = video.videoHeight;
  const scaleX = vw / vr.width; const scaleY = vh / vr.height;
  return {x: roiOverlay.x*scaleX, y: roiOverlay.y*scaleY, w: roiOverlay.w*scaleX, h: roiOverlay.h*scaleY};
}

async function analyzeWithYOLO(){
  if(!modelLoaded){ alert('모델이 로드되어 있지 않습니다.'); return; }
  detectionsPerFrame = [];
  const fps = getFpsValue() || 30;
  const duration = video.duration || 0;
  const totalFrames = Math.floor(duration*fps);
  const confTh = getConfValue();

  // For stability, pause playback and step through frames by seeking
  const start = 0; const end = totalFrames;
  video.pause();
  for(let i=start;i<end;i++){
    const t = i/fps;
    await seekToTime(t);
    // draw current frame to offscreen canvas and prepare tensor
    const imgData = captureFrameImage();
    const {tensor, padInfo} = preprocessForYOLO(imgData, 640);
    const inputName = modelSession.inputNames[0];
    const feeds = {};
    feeds[inputName] = tensor;
    let output = null;
    try{
      const results = await modelSession.run(feeds);
      const outName = modelSession.outputNames[0];
      output = results[outName];
    }catch(err){
      console.error('모델 실행 중 오류', err); alert('모델 실행 실패'); return;
    }
    // parse output assuming YOLOv8 ONNX export shape [1, N, 85] (xywh, conf, class probs)
    const detections = parseYoloOutput(output, padInfo, confTh);
    // choose best detection: if ROI present choose overlap, else choose highest score
    let chosen = null;
    if(roi && detections.length){
      const vroi = roiToVideoBox(roi);
      let bestIoU=0;
      for(const d of detections){
        const iou = boxIoU(d.box, [vroi.x, vroi.y, vroi.x+vroi.w, vroi.y+vroi.h]);
        if(iou>bestIoU){ bestIoU=iou; chosen=d; }
      }
      if(bestIoU<0.05) chosen = detections[0];
    }else if(detections.length){
      chosen = detections[0];
    }
    if(chosen) detectionsPerFrame.push({time:video.currentTime, box:chosen.box, score:chosen.score});
    else detectionsPerFrame.push({time:video.currentTime, box:null, score:0});
    // update overlay occasionally
    if(i%10===0) drawOverlay();
  }
  analyzeTrackData();
}

function captureFrameImage(videoEl){
  // draw provided video element's current frame to temp canvas and return canvas
  const src = videoEl || video;
  const tmp = document.createElement('canvas');
  // some browsers/devices can report video.videoWidth==0 intermittently; fall back to client sizes
  const cssW = (src && src.videoWidth) || Math.max(320, (src && src.clientWidth) || 320);
  const cssH = (src && src.videoHeight) || Math.max(240, (src && src.clientHeight) || 240);
  const dpr = window.devicePixelRatio || 1;
  // internal pixel size scaled by DPR for sharpness; CSS size stored for coordinate math
  tmp.width = Math.max(1, Math.round(cssW * dpr));
  tmp.height = Math.max(1, Math.round(cssH * dpr));
  try{ tmp.style.width = cssW + 'px'; tmp.style.height = cssH + 'px'; }catch(e){}
  // attach metadata so consumers can compute CSS-based scales
  tmp._cssWidth = cssW; tmp._cssHeight = cssH; tmp._dpr = dpr;
  const tctx = tmp.getContext('2d');
  try{
    // scale ctx so drawing coordinates are in CSS pixels
    try{ tctx.setTransform(dpr,0,0,dpr,0,0); }catch(e){}
    // draw using CSS pixel dimensions so source scaling is explicit
    tctx.drawImage(src, 0,0, cssW, cssH);
  }catch(err){
    console.warn('captureFrameImage drawImage failed, returning blank canvas', err, 'videoEl readyState=', src && src.readyState, 'videoWidth=', src && src.videoWidth, 'clientWidth=', src && src.clientWidth);
    // ensure fill uses internal pixels
    try{ tctx.setTransform(1,0,0,1,0,0); }catch(e){}
    tctx.fillStyle = 'rgb(100,100,100)'; tctx.fillRect(0,0,tmp.width,tmp.height);
  }
  console.log('captureFrameImage created canvas', tmp.width, 'x', tmp.height, 'css', cssW, 'x', cssH, 'dpr', dpr);
  return tmp;
}

function preprocessForYOLO(canvas, size){
  // letterbox to square size, normalize to [0,1], create ort tensor with shape [1,3,size,size]
  const iw = canvas.width, ih = canvas.height;
  const scale = Math.min(size/iw, size/ih);
  const nw = Math.round(iw*scale), nh = Math.round(ih*scale);
  const padW = size - nw, padH = size - nh;
  const dx = Math.floor(padW/2), dy = Math.floor(padH/2);
  const tmp = document.createElement('canvas'); tmp.width=size; tmp.height=size;
  const tctx = tmp.getContext('2d');
  // fill with gray
  tctx.fillStyle = 'rgb(114,114,114)'; tctx.fillRect(0,0,size,size);
  tctx.drawImage(canvas, 0,0,iw,ih, dx,dy, nw, nh);
  // get image data
  const id = tctx.getImageData(0,0,size,size).data;
  // create Float32Array [1,3,size,size] CHW
  const float32 = new Float32Array(1*3*size*size);
  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      const i = (y*size + x)*4;
      const r = id[i]/255; const g = id[i+1]/255; const b = id[i+2]/255;
      const idx = y*size + x;
      float32[idx] = r;
      float32[size*size + idx] = g;
      float32[2*size*size + idx] = b;
    }
  }
  const tensor = new ort.Tensor('float32', float32, [1,3,size,size]);
  return {tensor, padInfo:{dx,dy,scale}};
}

function parseYoloOutput(outputTensor, padInfo, confThreshold){
  // Flexible parser for common YOLOv8 ONNX exports.
  // Handles outputs shaped [1,N,C] or [N,C] where C >= 5 (xywh + obj + classes)
  const results = [];
  if(!outputTensor) return results;
  const data = outputTensor.data;
  const shape = outputTensor.dims || [];
  let N=0, C=0, offsetRow=0;
  if(shape.length===3 && shape[0]===1){ N = shape[1]; C = shape[2]; offsetRow = C; }
  else if(shape.length===2){ N = shape[0]; C = shape[1]; offsetRow = C; }
  else {
    console.warn('Unexpected model output shape', shape);
    return results;
  }

  for(let i=0;i<N;i++){
    const base = i*offsetRow;
    // Guard against short rows
    if(base + Math.min(6,C) > data.length) break;

    // Typical layout: [cx,cy,w,h,obj_conf, class_probs...]
    const cx = data[base + 0];
    const cy = data[base + 1];
    const w = data[base + 2];
    const h = data[base + 3];

    // objectness / confidence
    const objConf = (C>4) ? data[base + 4] : 1.0;

    // class probabilities may start at index 5
    let cls = 0; let maxp = 0;
    if(C > 5){
      for(let c=5;c<C;c++){ const p = data[base + c]; if(p>maxp){ maxp = p; cls = c-5; } }
    } else if(C===6){
      // sometimes last column is a single class id/score
      maxp = data[base + 5] || 1.0;
      cls = 0;
    } else {
      maxp = 1.0; cls = 0;
    }

    const score = objConf * maxp;
    if(score < confThreshold) continue;

    // convert from letterboxed input coords back to original video pixels
    // many ONNX exports use xywh in pixels relative to the model input size
    const x1 = (cx - w/2 - padInfo.dx)/padInfo.scale;
    const y1 = (cy - h/2 - padInfo.dy)/padInfo.scale;
    const x2 = (cx + w/2 - padInfo.dx)/padInfo.scale;
    const y2 = (cy + h/2 - padInfo.dy)/padInfo.scale;

    results.push({box:[x1,y1,x2,y2], score, class:cls});
  }

  results.sort((a,b)=>b.score-a.score);
  return nms(results, 0.45);
}

function nms(boxes, iouThreshold){
  const out = [];
  for(const b of boxes){
    let keep = true;
    for(const o of out){ if(boxIoU(o.box, b.box) > iouThreshold) { keep = false; break; } }
    if(keep) out.push(b);
  }
  return out;
}

function boxIoU(a,b){
  if(!a||!b) return 0;
  const [ax1,ay1,ax2,ay2] = a; const [bx1,by1,bx2,by2] = b;
  const ix1 = Math.max(ax1,bx1), iy1 = Math.max(ay1,by1);
  const ix2 = Math.min(ax2,bx2), iy2 = Math.min(ay2,by2);
  const iw = Math.max(0, ix2-ix1), ih = Math.max(0, iy2-iy1);
  const inter = iw*ih;
  const aarea = Math.max(0,ax2-ax1)*Math.max(0,ay2-ay1);
  const barea = Math.max(0,bx2-bx1)*Math.max(0,by2-by1);
  return inter / (aarea + barea - inter + 1e-6);
}

function seekToTime(t, videoEl){
  const src = videoEl || video;
  return new Promise((res,rej)=>{
    let done = false;
    const startMs = Date.now();
    const clearAll = ()=>{ try{ src.removeEventListener('seeked', onseek); src.removeEventListener('timeupdate', ontime); if(typeof cancelVideoFrameCallback === 'function' && vidRVCId) cancelVideoFrameCallback(vidRVCId); }catch(e){} };
    const onseek = ()=>{ if(done) return; done = true; clearTimeout(timer); clearAll(); console.log('seekToTime resolved by seeked after', Date.now()-startMs,'ms, video.currentTime=',src.currentTime); res(); };
    const ontime = ()=>{ if(done) return; done = true; clearTimeout(timer); clearAll(); console.log('seekToTime resolved by timeupdate after', Date.now()-startMs,'ms, video.currentTime=',src.currentTime); res(); };
    // If requestVideoFrameCallback is available, use it as a fast reliable hook (newer Safari)
    let vidRVCId = null;
    const useRVC = (typeof src.requestVideoFrameCallback === 'function');
    if(useRVC){
      try{
        vidRVCId = src.requestVideoFrameCallback(()=>{ if(done) return; done = true; clearTimeout(timer); clearAll(); console.log('seekToTime resolved by requestVideoFrameCallback after', Date.now()-startMs,'ms, video.currentTime=',src.currentTime); res(); });
      }catch(e){ console.warn('requestVideoFrameCallback failed', e); }
    }
    src.addEventListener('seeked', onseek);
    src.addEventListener('timeupdate', ontime);
    try{ 
      console.log('seekToTime setting currentTime to', Math.min(src.duration || t, t), 'readyState=', src.readyState, 'videoWidth=', src.videoWidth, 'videoHeight=', src.videoHeight);
      src.currentTime = Math.min(src.duration || t, t);
    }catch(err){ console.warn('seekToTime set currentTime failed', err); }
    // fallback: if neither event fired within 3000ms, resolve anyway to avoid stalling on slow mobile
    const timer = setTimeout(()=>{ if(done) return; done = true; clearAll(); console.warn('seekToTime fallback timeout for', t); res(); }, 3000);
  });
}

function analyzeTrackData(){
  // Build time series of centroid positions (in video pixels), speed and acceleration
  const points = [];
  for(const f of detectionsPerFrame){
    if(f.box){
      const [x1,y1,x2,y2] = f.box; const cx=(x1+x2)/2; const cy=(y1+y2)/2;
      points.push({t:f.time, x:cx, y:cy});
    }else{
      points.push({t:f.time, x:null, y:null});
    }
  }
  // compute speed and accel
  const speeds = [], accs = [];
  for(let i=0;i<points.length;i++){
    if(i===0){ speeds.push(null); accs.push(null); continue; }
    const p0 = points[i-1], p1 = points[i];
    if(p0.x==null||p1.x==null){ speeds.push(null); accs.push(null); continue; }
    const dt = p1.t - p0.t || 1/30;
    const dx = (p1.x - p0.x); const dy = (p1.y - p0.y);
    const distPx = Math.hypot(dx,dy);
    const speed = (distPx / dt) / scalePxPerUnit; // units per second
    speeds.push(speed);
    if(i===1) { accs.push(null); continue; }
    const prevSpeed = speeds[i-1] || 0;
    const acc = (speed - prevSpeed)/dt; accs.push(acc);
  }

  // draw charts
  drawCharts(points, speeds);
  // store analysis for export
  analysisResult = {points, speeds, accs};
  drawOverlay();
  alert('분석이 완료되었습니다. 결과를 시각화했습니다.');
}

let analysisResult = null;
// Extraction guard (declared earlier)

// On-screen mobile status log (useful for Safari where user may not have console)
function mobileLog(msg){
  try{
    let el = document.getElementById('mobileStatusLog');
    if(!el){ el = document.createElement('div'); el.id = 'mobileStatusLog'; el.style.position='fixed'; el.style.left='8px'; el.style.right='8px'; el.style.bottom='12px'; el.style.padding='8px 10px'; el.style.background='rgba(0,0,0,0.6)'; el.style.color='#fff'; el.style.fontSize='12px'; el.style.borderRadius='8px'; el.style.zIndex='9999'; el.style.maxHeight='160px'; el.style.overflow='auto'; document.body.appendChild(el); }
    const p = document.createElement('div'); p.textContent = `${new Date().toLocaleTimeString()} ${msg}`; el.appendChild(p); if(el.childNodes.length>6) el.removeChild(el.firstChild);
  }catch(e){ console.warn('mobileLog failed', e); }
}

function drawCharts(points, speeds){
  const labels = points.map(p=>p.t.toFixed(2));
  const xs = points.map(p=>p.x ? p.x/scalePxPerUnit : null);
  const ys = points.map(p=>p.y ? p.y/scalePxPerUnit : null);
  const speedData = speeds.map(s=>s||0);

  if(posChart) posChart.destroy();
  const posCtx = document.getElementById('posChart').getContext('2d');
  posChart = new Chart(posCtx, {
    type:'line', data:{ labels, datasets:[{label:'X (units)', data:xs, borderColor:'#4fd1c5', tension:0.2, spanGaps:true},{label:'Y (units)', data:ys, borderColor:'#f97316', tension:0.2, spanGaps:true}]}, options:{responsive:true, maintainAspectRatio:false}
  });

  if(velChart) velChart.destroy();
  const velCtx = document.getElementById('velChart').getContext('2d');
  velChart = new Chart(velCtx, {type:'line', data:{labels,datasets:[{label:'Speed (units/s)', data:speedData, borderColor:'#60a5fa', tension:0.2, spanGaps:true}]}, options:{responsive:true, maintainAspectRatio:false}});
}

if(exportCSVBtn) bindMulti(exportCSVBtn, (e)=>{
  if(e && e.preventDefault) e.preventDefault();
  if(!analysisResult){ alert('분석 후 내보내기 하세요.'); return; }
  const rows = [['frame','time_s','x_px','y_px','x_unit','y_unit','speed_unit_s','acc_unit_s2']];
  for(let i=0;i<detectionsPerFrame.length;i++){
    const d = detectionsPerFrame[i];
    const a = analysisResult.points[i];
    const s = analysisResult.speeds[i] || '';
    const acc = analysisResult.accs[i] || '';
    const x_px = a.x||''; const y_px = a.y||'';
    const x_u = a.x ? (a.x/scalePxPerUnit).toFixed(4) : '';
    const y_u = a.y ? (a.y/scalePxPerUnit).toFixed(4) : '';
    rows.push([i, (d.time||'').toFixed(4), x_px, y_px, x_u, y_u, s, acc]);
  }
  const csv = rows.map(r=>r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'analysis.csv'; a.click(); URL.revokeObjectURL(url);
});

// Utility: map overlay coords to video coords and vice versa used above

// Accessibility: reload model button via double-click on title
const _hdrTitle = document.querySelector('header h1');
if(_hdrTitle) _hdrTitle.addEventListener('dblclick', ()=>{ if(confirm('모델을 다시 로드하시겠습니까?')) loadModel(); });

// Initial overlay draw loop
setInterval(()=>{ drawOverlay(); }, 200);
