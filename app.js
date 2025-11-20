// Motion Tracker main app.js
// 주요기능: 비디오 업로드/카메라, ROI 선택, ONNX(YOLO) 모델 로드(선택), 프레임별 검출 및 궤적/속도 분석, CSV 내보내기

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');

const videoFile = document.getElementById('videoFile');
const stepCameraBtn = document.getElementById('stepCamera');
const stepExtractBtn = document.getElementById('stepExtract');
const stepROIBtn = document.getElementById('stepROI');
const stepAnalyzeBtn = document.getElementById('stepAnalyze');
const extractProgress = document.getElementById('extractProgress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const prevFrameBtn = document.getElementById('prevFrame');
const nextFrameBtn = document.getElementById('nextFrame');
const frameIdxEl = document.getElementById('frameIdx');
const frameROIBtn = document.getElementById('frameROI');
const tabContents = {
  1: document.getElementById('tab-1'),
  2: document.getElementById('tab-2'),
  3: document.getElementById('tab-3'),
  4: document.getElementById('tab-4')
};
const startCameraBtn = document.getElementById('startCamera');
const recordToggleBtn = document.getElementById('recordToggle');
const captureFrameBtn = document.getElementById('captureFrame');
const extractFramesBtn = document.getElementById('extractFramesBtn');
const completeROIsBtn = document.getElementById('completeROIs');
const playResultsBtn = document.getElementById('playResultsBtn');
const selectROIBtn = document.getElementById('selectROI');
const runDetectBtn = document.getElementById('runDetect');
const exportCSVBtn = document.getElementById('exportCSV');
const modelFileInput = document.getElementById('modelFile');
const inspectModelBtn = document.getElementById('inspectModel');

// Note: there are duplicate ID inputs in the page (one inside tab-2 and one in the footer).
// Use helper accessors that prefer the tab-2 inputs to avoid reading the wrong element.
function getFpsValue(){ const el = document.querySelector('#tab-2 #fpsInput') || document.getElementById('fpsInput'); return Number(el && el.value) || 10; }
function getConfValue(){ const el = document.querySelector('#tab-2 #confInput') || document.getElementById('confInput'); return Number(el && el.value) || 0.3; }
function getScaleValue(){ const el = document.getElementById('scaleInput'); return parseFloat(el && el.value) || 1; }

let modelSession = null;
let modelLoaded = false;
// Use the local ONNX file bundled in the project root by default.
// If you prefer a different location, change this path (e.g. './model/yolov8n.onnx').
let modelPath = './yolov8n.onnx'; // default to local file in project root
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];

// Frame extraction / per-frame state
let extractedFrames = []; // array of canvas images
let currentFrameIndex = 0;
let frameROIs = {}; // map frameIndex -> {x,y,w,h}

// Extraction guard (declare early to avoid TDZ when handlers fire quickly)
let isExtracting = false;

// Simplify initial UI: disable steps until prerequisites
if(stepExtractBtn) stepExtractBtn.disabled = true;
if(stepROIBtn) stepROIBtn.disabled = true;
if(stepAnalyzeBtn) stepAnalyzeBtn.disabled = true;

// Tab switching
function switchTab(n){
  // highlight header
  [1,2,3,4].forEach(i=>{
    const b = document.getElementById('step'+(i===1? 'Camera': i===2? 'Extract': i===3? 'ROI': 'Analyze'));
    if(b) b.classList.toggle('active', i===n);
    const c = tabContents[i]; if(c) c.style.display = (i===n) ? '' : 'none';
  });
  try{ onTabShown(n); }catch(e){}
}
// default to tab 1
switchTab(1);

// When tab 2 becomes visible, ensure extract button is enabled when a video source exists
function onTabShown(n){
  if(n===2){
    // enable the extract button if a video is loaded or a blob URL is present
    try{
      const hasVideo = !!(video && (video.src || video.srcObject));
      if(extractFramesBtn) extractFramesBtn.disabled = !hasVideo;
    }catch(e){ console.warn('onTabShown error', e); }
  }
}

// Robust binding for extract button: attach click/pointerdown/touchstart and guard against missing element
function startExtractionIfReady(e){
  if(e && e.preventDefault) e.preventDefault();
  if(!extractFramesBtn) return;
  // prevent double start
  if(isExtracting){ console.warn('already extracting'); return; }
  // if button is disabled but video looks ready, enable and continue
  try{
    const ready = !!(video && (video.src || video.srcObject) && (video.readyState >= 2 || (video.duration && !isNaN(video.duration) && video.duration>0)));
    if(extractFramesBtn.disabled && ready){ extractFramesBtn.disabled = false; }
    if(extractFramesBtn.disabled){ console.warn('extractFramesBtn is disabled'); mobileLog('버튼이 비활성화되어 시작할 수 없습니다. 비디오를 확인하세요.'); return; }
  }catch(e){ console.warn('startExtractionIfReady check failed', e); }
  // run extraction (wrapped) and ensure tab 2 is visible
  switchTab(2);
  // Use a microtask to let tab render then start
  Promise.resolve().then(()=>{ isExtracting = true; mobileLog('추출 시작'); extractFrames().catch(err=>{ console.error('extractFrames error', err); mobileLog('추출 오류: '+(err && err.message)); }).finally(()=>{ isExtracting = false; mobileLog('추출 종료'); }); });
}

function bindExtractButton(){
  if(!extractFramesBtn) return;
  // remove previous handlers to avoid duplicates
  extractFramesBtn.removeEventListener('click', startExtractionIfReady);
  extractFramesBtn.removeEventListener('pointerdown', startExtractionIfReady);
  extractFramesBtn.removeEventListener('touchstart', startExtractionIfReady);
  extractFramesBtn.removeEventListener('touchend', startExtractionIfReady);
  extractFramesBtn.addEventListener('click', startExtractionIfReady);
  extractFramesBtn.addEventListener('pointerdown', startExtractionIfReady);
  extractFramesBtn.addEventListener('touchstart', startExtractionIfReady, {passive:false});
  extractFramesBtn.addEventListener('touchend', startExtractionIfReady, {passive:false});
  // ensure initial enabled state: enable only if video loaded
  try{ const hasVideo = !!(video && (video.src || video.srcObject)); extractFramesBtn.disabled = !hasVideo; }catch(e){}
}

// bind now
bindExtractButton();

// Robustly bind other UI buttons (prev/next/frame ROI/play/export) to support click/pointer/touch across devices
function bindAllUI(){
  // helper to safely bind multiple event types
  function bindMulti(el, handler){
    if(!el) return;
    el.removeEventListener('click', handler);
    el.removeEventListener('pointerdown', handler);
    el.removeEventListener('touchstart', handler);
    el.removeEventListener('touchend', handler);
    el.addEventListener('click', handler);
    el.addEventListener('pointerdown', handler);
    el.addEventListener('touchstart', handler, {passive:true});
    el.addEventListener('touchend', handler, {passive:true});
  }

  bindMulti(prevFrameBtn, (e)=>{ if(e && e.preventDefault) e.preventDefault(); showFrame(currentFrameIndex-1); });
  bindMulti(nextFrameBtn, (e)=>{ if(e && e.preventDefault) e.preventDefault(); showFrame(currentFrameIndex+1); });
  bindMulti(frameROIBtn, (e)=>{ if(e && e.preventDefault) e.preventDefault();
    // reuse existing handler logic: open selection mode for current frame
    if(!extractedFrames || !extractedFrames.length) { mobileLog('프레임이 없습니다. 먼저 추출하세요.'); return; }
    selecting = true; mobileLog('프레임 ROI 선택 모드로 진입');
    alert('이 프레임에서 ROI를 드래그하여 선택하세요. 선택 후 빈 공간을 누르거나 다시 ROI 버튼을 누르세요.');
    const saveListener = ()=>{
      if(roi){
        const scaleX = extractedFrames[currentFrameIndex].width / overlay.width;
        const scaleY = extractedFrames[currentFrameIndex].height / overlay.height;
        frameROIs[currentFrameIndex] = {x: Math.round(roi.x*scaleX), y: Math.round(roi.y*scaleY), w: Math.round(roi.w*scaleX), h: Math.round(roi.h*scaleY)};
        selecting = false; roi = null; showFrame(currentFrameIndex);
        if(stepAnalyzeBtn) stepAnalyzeBtn.disabled = false;
        mobileLog(`ROI 저장: frame ${currentFrameIndex+1}`);
      }
      overlay.removeEventListener('pointerup', saveListener);
    };
    overlay.addEventListener('pointerup', saveListener);
  });

  bindMulti(playResultsBtn, (e)=>{ if(e && e.preventDefault) e.preventDefault(); playResults(); switchTab(4); });
  bindMulti(completeROIsBtn, (e)=>{ if(e && e.preventDefault) e.preventDefault(); switchTab(4); if(stepAnalyzeBtn) stepAnalyzeBtn.click(); });
  // exportCSVBtn already has its own handler; no need to rebind to avoid recursion
}

// call binding for other UI
bindAllUI();


// Start with inspect button disabled until a model is found
if(inspectModelBtn) inspectModelBtn.disabled = true;

// Immediately show model loading attempt text so user isn't left with '대기 중'
const statusElInit = document.getElementById('status');
if(statusElInit) statusElInit.textContent = '모델 로드 상태: 로딩 시도 중...';

// Analysis data
let detectionsPerFrame = []; // [{time, box: [x1,y1,x2,y2], score}]
let scalePxPerUnit = getScaleValue();

// ROI selection
let selecting = false;
let roi = null; // {x,y,w,h}

// Charts
let posChart, velChart;

function resizeOverlay(){
  overlay.width = video.clientWidth;
  overlay.height = video.clientHeight;
}

window.addEventListener('resize', resizeOverlay);
video.addEventListener('loadedmetadata', ()=>{
  resizeOverlay();
});

videoFile.addEventListener('change', (e)=>{
  const f = e.target.files && e.target.files[0];
  if(!f) return;
  const url = URL.createObjectURL(f);
  // If a camera stream is active, stop it so we treat this as an uploaded file
  if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); currentStream = null; }
  if(mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  video.srcObject = null;
  video.src = url;
  video.muted = false;
  video.play();
  // enable extract step once video is loaded
  video.addEventListener('loadedmetadata', ()=>{ 
    if(stepExtractBtn) stepExtractBtn.disabled = false; 
    // automatically switch to the Frame Extraction tab so users can proceed
    try{ switchTab(2); }catch(e){}
  }, {once:true});
});

// Camera flow: open preview and enable recording. Recording will create a blob video which
// replaces the preview as a file-like source for analysis.
startCameraBtn.addEventListener('click', async ()=>{
  try{
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}, audio:true});
    currentStream = stream;
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // enable record button and show it
    if(recordToggleBtn){ recordToggleBtn.style.display = ''; recordToggleBtn.disabled = false; recordToggleBtn.textContent = '녹화 시작'; }
  }catch(err){
    alert('카메라 권한이 필요합니다: '+err.message);
  }
});

// Step camera/file: open camera or file picker
if(stepCameraBtn){
  stepCameraBtn.addEventListener('click', ()=>{
    // switch to camera tab content and trigger camera/file UI
    switchTab(1);
    // prefer camera if available, else open file selector
    if(navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
      // show record button
      const rec = document.getElementById('recordToggle'); if(rec){ rec.style.display = ''; rec.disabled = false; }
      startCameraBtn.click();
    }else{
      if(videoFile) videoFile.click();
    }
  });
}

// Recording toggle: start/stop
if(recordToggleBtn){
  recordToggleBtn.addEventListener('click', ()=>{
    if(!currentStream) return;
    if(mediaRecorder && mediaRecorder.state === 'recording'){
      mediaRecorder.stop();
      recordToggleBtn.textContent = '녹화 시작';
      recordToggleBtn.disabled = true;
      return;
    }
    recordedChunks = [];
    try{ mediaRecorder = new MediaRecorder(currentStream, {mimeType:'video/webm;codecs=vp9'}); }catch(e){ mediaRecorder = new MediaRecorder(currentStream); }
    mediaRecorder.ondataavailable = (ev)=>{ if(ev.data && ev.data.size>0) recordedChunks.push(ev.data); };
    mediaRecorder.onstop = async ()=>{
      if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); }
      const blob = new Blob(recordedChunks, {type: recordedChunks[0]?.type || 'video/webm'});
      const url = URL.createObjectURL(blob);
      video.srcObject = null;
      video.src = url;
      video.muted = false;
      await video.play().catch(()=>{});
      // hide record controls until user re-opens camera
      recordToggleBtn.style.display = 'none'; recordToggleBtn.disabled = true;
      currentStream = null;
      // enable extract step after recording is available as a file-like source
      if(stepExtractBtn) stepExtractBtn.disabled = false;
      // automatically switch to Frame Extraction tab so user can start extraction
      try{ switchTab(2); }catch(e){ console.warn('switchTab failed after recording', e); }
    };
    mediaRecorder.start();
    recordToggleBtn.textContent = '녹화 중지';
  });
}

function stopCameraStream(){
  const s = video.srcObject || currentStream;
  if(s && s.getTracks) s.getTracks().forEach(t=>t.stop());
  video.srcObject = null;
  currentStream = null;
}

if(captureFrameBtn) captureFrameBtn.addEventListener('click', ()=>{
  // draw current frame to overlay for user to save/view
  drawOverlay();
});

// Extract frames: sample video at fpsInput value and store canvases
async function extractFrames(){
  if(!video){ alert('비디오 요소가 준비되지 않았습니다.'); return; }
  // ensure metadata/duration is available
  if(!video.duration || isNaN(video.duration) || video.duration===0){
    await new Promise(res=>{ video.addEventListener('loadedmetadata', ()=>res(), {once:true}); });
  }
  if(!video.duration || isNaN(video.duration) || video.duration===0){ alert('비디오 정보를 불러오지 못했습니다. 다른 파일을 시도하세요.'); return; }
  extractedFrames = [];
  // For stability on mobile, pause playback before performing many seeks
  try{ video.pause(); }catch(e){ console.warn('video.pause() failed', e); }
  const fps = getFpsValue();
  const duration = video.duration;
  const total = Math.max(1, Math.floor(duration * fps));
  try{
    console.log('extractFrames start', {duration, fps, total});
    // Use the extract button itself as the progress indicator (mobile-friendly)
    if(extractProgress) extractProgress.style.display = 'none'; // hide original bar
    if(extractFramesBtn){
      extractFramesBtn.disabled = true;
      extractFramesBtn.dataset.origText = extractFramesBtn.innerHTML;
      // immediately show simple '추출중' status when extraction begins
      extractFramesBtn.textContent = '추출중';
      // Make sure button uses block layout on narrow devices
      extractFramesBtn.style.display = 'inline-block';
      extractFramesBtn.style.transition = 'background 120ms linear';
    }
    for(let i=0;i<total;i++){
    const t = i / fps;
      const pctNum = Math.round(((i+1)/total)*100);
      if(progressText) progressText.textContent = `프레임 추출: ${i+1} / ${total}`;
      // Update extract button visually to show progress
      if(extractFramesBtn){
        const txt = `추출중 ${i+1}/${total} (${pctNum}%)`;
        extractFramesBtn.textContent = txt;
        // visual fill using linear-gradient background (left: progress colour, right: base)
        extractFramesBtn.style.background = `linear-gradient(90deg,#4fd1c5 ${pctNum}%, #06b6d4 ${pctNum}%)`;
        try{ requestAnimationFrame(()=>{ extractFramesBtn.style.background = `linear-gradient(90deg,#4fd1c5 ${pctNum}%, #06b6d4 ${pctNum}%)`; }); }catch(e){}
      }
      console.log(`seek to ${t.toFixed(3)}s (${i+1}/${total})`);
      await seekToTime(t);
      const c = captureFrameImage();
      // store a copy canvas
      const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
      copy.getContext('2d').drawImage(c,0,0);
      extractedFrames.push(copy);
      // small yield
      await new Promise(r=>setTimeout(r,10));
    }
    progressText.textContent = `추출 완료: ${extractedFrames.length} frames`;
    if(extractFramesBtn){ extractFramesBtn.textContent = `추출 완료 (${extractedFrames.length})`; extractFramesBtn.style.background = `linear-gradient(90deg,#4fd1c5 100%, #06b6d4 100%)`; }
    // show frame navigation UI
    const nav = document.querySelector('.frame-nav'); if(nav) nav.style.display = '';
  // ensure nav buttons are enabled
  try{ if(prevFrameBtn) prevFrameBtn.disabled = false; if(nextFrameBtn) nextFrameBtn.disabled = false; if(frameROIBtn) frameROIBtn.disabled = false; }catch(e){}
    currentFrameIndex = 0; showFrame(0);
    if(stepROIBtn) stepROIBtn.disabled = false;
    if(stepExtractBtn) stepExtractBtn.disabled = true;
    if(extractFramesBtn) {
      // restore button after a short pause so user sees completion
      setTimeout(()=>{ extractFramesBtn.disabled = false; if(extractFramesBtn.dataset.origText) extractFramesBtn.innerHTML = extractFramesBtn.dataset.origText; extractFramesBtn.style.background = ''; }, 1200);
    }
  }catch(err){
    console.error('extractFrames failed', err);
    alert('프레임 추출 중 오류가 발생했습니다. 콘솔을 확인하세요.');
    if(extractFramesBtn) extractFramesBtn.disabled = false;
    if(progressText) progressText.textContent = '프레임 추출 실패';
  }
}

if(stepExtractBtn){ stepExtractBtn.addEventListener('click', ()=>{ extractFrames(); }); }
// also switch to tab 2 when extract button clicked
if(stepExtractBtn) stepExtractBtn.addEventListener('click', ()=>{ switchTab(2); });
// header tab clicks should switch tabs
if(stepExtractBtn) stepExtractBtn.addEventListener('click', ()=>{ switchTab(2); });
if(stepROIBtn) stepROIBtn.addEventListener('click', ()=>{ switchTab(3); });
if(stepCameraBtn) stepCameraBtn.addEventListener('click', ()=>{ switchTab(1); });
const stepAnalyzeHeader = document.getElementById('stepAnalyze');
if(stepAnalyzeHeader) stepAnalyzeHeader.addEventListener('click', ()=>{ switchTab(4); });

if(selectROIBtn) selectROIBtn.addEventListener('click', ()=>{
  selecting = true;
  roi = null;
  alert('영역을 화면에서 터치하거나 마우스로 드래그하여 선택하세요. 완료되면 다시 ROI 버튼을 누르세요.');
});

overlay.addEventListener('pointerdown', (e)=>{
  if(!selecting) return;
  const r = overlay.getBoundingClientRect();
  const startX = e.clientX - r.left;
  const startY = e.clientY - r.top;
  let curX = startX, curY = startY;

  function move(ev){
    curX = ev.clientX - r.left; curY = ev.clientY - r.top;
    drawOverlay();
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
    ctx.strokeRect(Math.min(startX,curX), Math.min(startY,curY), Math.abs(curX-startX), Math.abs(curY-startY));
  }
  function up(ev){
    overlay.removeEventListener('pointermove', move);
    overlay.removeEventListener('pointerup', up);
    const endX = curX; const endY = curY;
    roi = {
      x: Math.min(startX,endX), y: Math.min(startY,endY), w: Math.abs(endX-startX), h: Math.abs(endY-startY)
    };
    selecting = false;
    drawOverlay();
  }
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerup', up);
});

// Frame navigation and per-frame ROI selection
function showFrame(idx){
  if(!extractedFrames || !extractedFrames.length) return;
  currentFrameIndex = Math.max(0, Math.min(idx, extractedFrames.length-1));
  const c = extractedFrames[currentFrameIndex];
  // draw frame into overlay sized to the visible video area
  const displayW = video.clientWidth || overlay.clientWidth || 640;
  const displayH = video.clientHeight || overlay.clientHeight || 360;
  overlay.width = displayW;
  overlay.height = displayH;
  const drawCtx = overlay.getContext('2d');
  drawCtx.clearRect(0,0,overlay.width,overlay.height);
  // scale image to overlay size
  drawCtx.drawImage(c, 0,0, c.width, c.height, 0,0, overlay.width, overlay.height);
  // if ROI exists for this frame, draw it
  const roiObj = frameROIs[currentFrameIndex];
  if(roiObj){
    // scale stored ROI (stored in original canvas coords) to overlay display
    const sx = roiObj.x * (overlay.width / c.width);
    const sy = roiObj.y * (overlay.height / c.height);
    const sw = roiObj.w * (overlay.width / c.width);
    const sh = roiObj.h * (overlay.height / c.height);
    drawCtx.strokeStyle='#00ff88'; drawCtx.lineWidth=2; drawCtx.strokeRect(sx, sy, sw, sh);
  }
  // update index label
  if(frameIdxEl) frameIdxEl.textContent = `Frame ${currentFrameIndex+1} / ${extractedFrames.length}`;
}

if(prevFrameBtn) prevFrameBtn.addEventListener('click', ()=>{ showFrame(currentFrameIndex-1); });
if(nextFrameBtn) nextFrameBtn.addEventListener('click', ()=>{ showFrame(currentFrameIndex+1); });

// extractFramesBtn binding is handled by bindExtractButton() above which supports click/pointer/touch events

// complete ROIs button triggers analysis (stepAnalyzeBtn handler)
if(completeROIsBtn){
  completeROIsBtn.addEventListener('click', ()=>{
    // move to analyze tab then run analysis
    switchTab(4);
    if(stepAnalyzeBtn) stepAnalyzeBtn.click();
  });
}

if(playResultsBtn){ playResultsBtn.addEventListener('click', ()=>{ playResults(); switchTab(4); }); }

function drawOverlay(){
  ctx.clearRect(0,0,overlay.width,overlay.height);
  if(roi){
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
    ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
  }
  // draw latest detection for current frame if any
  const last = detectionsPerFrame.length ? detectionsPerFrame[detectionsPerFrame.length-1] : null;
  if(last && last.box){
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ff0066'; ctx.lineWidth = 2;
    const [x1,y1,x2,y2] = mapBoxToOverlay(last.box);
    ctx.strokeRect(x1,y1,x2-x1,y2-y1);
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
      const drawCtx = overlay.getContext('2d');
      overlay.width = video.clientWidth; overlay.height = video.clientHeight;
      drawCtx.clearRect(0,0,overlay.width,overlay.height);
      drawCtx.drawImage(c,0,0, overlay.width, overlay.height);
      const det = detectionsPerFrame[idx];
      if(det && det.box){ const [x1,y1,x2,y2]=det.box; const sx = x1*(overlay.width/c.width), sy=y1*(overlay.height/c.height), sw=(x2-x1)*(overlay.width/c.width), sh=(y2-y1)*(overlay.height/c.height); drawCtx.strokeStyle='#ff0066'; drawCtx.lineWidth=3; drawCtx.strokeRect(sx,sy,sw,sh); }
      idx++; if(idx>=total) idx=0;
    }, 1000 / fps);
  }

if(runDetectBtn) runDetectBtn.addEventListener('click', async ()=>{
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

function captureFrameImage(){
  // draw video current frame to temp canvas and return canvas
  const tmp = document.createElement('canvas');
  // some browsers/devices can report video.videoWidth==0 intermittently; fall back to client sizes
  const vw = video.videoWidth || Math.max(320, video.clientWidth);
  const vh = video.videoHeight || Math.max(240, video.clientHeight);
  tmp.width = vw; tmp.height = vh;
  const tctx = tmp.getContext('2d');
  try{
    tctx.drawImage(video, 0,0, tmp.width, tmp.height);
  }catch(err){
    console.warn('captureFrameImage drawImage failed, returning blank canvas', err);
    tctx.fillStyle = 'rgb(100,100,100)'; tctx.fillRect(0,0,tmp.width,tmp.height);
  }
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

function seekToTime(t){
  return new Promise((res,rej)=>{
    let done = false;
    const clearAll = ()=>{ try{ video.removeEventListener('seeked', onseek); video.removeEventListener('timeupdate', ontime); if(typeof cancelVideoFrameCallback === 'function' && vidRVCId) cancelVideoFrameCallback(vidRVCId); }catch(e){} };
    const onseek = ()=>{ if(done) return; done = true; clearTimeout(timer); clearAll(); res(); };
    const ontime = ()=>{ if(done) return; done = true; clearTimeout(timer); clearAll(); res(); };
    // If requestVideoFrameCallback is available, use it as a fast reliable hook (newer Safari)
    let vidRVCId = null;
    const useRVC = (typeof video.requestVideoFrameCallback === 'function');
    if(useRVC){
      try{
        vidRVCId = video.requestVideoFrameCallback(()=>{ if(done) return; done = true; clearTimeout(timer); clearAll(); res(); });
      }catch(e){ console.warn('requestVideoFrameCallback failed', e); }
    }
    video.addEventListener('seeked', onseek);
    video.addEventListener('timeupdate', ontime);
    try{ video.currentTime = Math.min(video.duration || t, t); }catch(err){ console.warn('seekToTime set currentTime failed', err); }
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

exportCSVBtn.addEventListener('click', ()=>{
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
