// Motion Tracker main app.js
// 주요기능: 비디오 업로드/카메라, ROI 선택, ONNX(YOLO) 모델 로드(선택), 프레임별 검출 및 궤적/속도 분석, CSV 내보내기

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');

const videoFile = document.getElementById('videoFile');
const startCameraBtn = document.getElementById('startCamera');
const recordToggleBtn = document.getElementById('recordToggle');
const captureFrameBtn = document.getElementById('captureFrame');
const selectROIBtn = document.getElementById('selectROI');
const runDetectBtn = document.getElementById('runDetect');
const exportCSVBtn = document.getElementById('exportCSV');
const modelFileInput = document.getElementById('modelFile');
const inspectModelBtn = document.getElementById('inspectModel');

const fpsInput = document.getElementById('fpsInput');
const confInput = document.getElementById('confInput');
const scaleInput = document.getElementById('scaleInput');

let modelSession = null;
let modelLoaded = false;
// Use the local ONNX file bundled in the project root by default.
// If you prefer a different location, change this path (e.g. './model/yolov8n.onnx').
let modelPath = './yolov8n.onnx'; // default to local file in project root
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];

// Start with inspect button disabled until a model is found
if(inspectModelBtn) inspectModelBtn.disabled = true;

// Analysis data
let detectionsPerFrame = []; // [{time, box: [x1,y1,x2,y2], score}]
let scalePxPerUnit = parseFloat(scaleInput.value) || 1;

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

captureFrameBtn.addEventListener('click', ()=>{
  // draw current frame to overlay for user to save/view
  drawOverlay();
});

selectROIBtn.addEventListener('click', ()=>{
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
        const parsed = parseYoloOutput(out[firstOutName], {dx:0,dy:0,scale:1}, Number(confInput.value)||0.1);
        console.log('Parsed detections sample (first 20):', parsed.slice(0,20));
      }
      alert('모델 검사가 완료되었습니다. 콘솔(개발자 도구)을 확인하세요.');
    }catch(err){
      console.error('Inspect model failed', err);
      alert('모델 검사 중 오류가 발생했습니다. 콘솔을 확인하세요.');
    }
  });
}

runDetectBtn.addEventListener('click', async ()=>{
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
  const fps = Number(fpsInput.value) || 30;
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
  const fps = Number(fpsInput.value) || 30;
  const duration = video.duration || 0;
  const totalFrames = Math.floor(duration*fps);
  const confTh = Number(confInput.value) || 0.3;

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
  tmp.width = video.videoWidth; tmp.height = video.videoHeight;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(video, 0,0,tmp.width, tmp.height);
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
    const onseek = ()=>{ video.removeEventListener('seeked', onseek); res(); };
    video.addEventListener('seeked', onseek);
    try{ video.currentTime = Math.min(video.duration || t, t); }catch(err){ video.removeEventListener('seeked', onseek); res(); }
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
document.querySelector('header h1').addEventListener('dblclick', ()=>{
  if(confirm('모델을 다시 로드하시겠습니까?')) loadModel();
});

// Initial overlay draw loop
setInterval(()=>{ drawOverlay(); }, 200);
