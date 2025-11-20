// Motion Tracker main app.js
// 주요기능: 비디오 업로드/카메라, ROI 선택, ONNX(YOLO) 모델 로드(선택), 프레임별 검출 및 궤적/속도 분석, CSV 내보내기

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');

const videoFile = document.getElementById('videoFile');
const startCameraBtn = document.getElementById('startCamera');
const captureFrameBtn = document.getElementById('captureFrame');
const selectROIBtn = document.getElementById('selectROI');
const runDetectBtn = document.getElementById('runDetect');
const exportCSVBtn = document.getElementById('exportCSV');

const fpsInput = document.getElementById('fpsInput');
const confInput = document.getElementById('confInput');
const scaleInput = document.getElementById('scaleInput');

let modelSession = null;
let modelLoaded = false;
let modelPath = 'model/yolov8n.onnx'; // 사용자 제공

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
  stopCameraStream();
  video.src = url;
  video.play();
});

startCameraBtn.addEventListener('click', async ()=>{
  try{
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}, audio:false});
    video.srcObject = stream;
    video.play();
  }catch(err){
    alert('카메라 권한이 필요합니다: '+err.message);
  }
});

function stopCameraStream(){
  const s = video.srcObject;
  if(s && s.getTracks) s.getTracks().forEach(t=>t.stop());
  video.srcObject = null;
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
  try{
    const opts = {executionProviders:['wasm','webgl']};
    modelSession = await ort.InferenceSession.create(modelPath, opts);
    modelLoaded = true;
    alert('모델을 로드했습니다. YOLO ONNX가 준비되었습니다.');
  }catch(err){
    console.warn('모델 로드 실패', err);
    modelLoaded = false;
    alert('모델 로드 실패: model/yolov8n.onnx 파일이 존재하고 CORS/서버가 필요합니다. 수동 ROI 추적 기능은 계속 사용 가능합니다.');
  }
}

// Try to load model at startup (non-blocking)
loadModel();

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
  // outputTensor is ort.Tensor
  // convert to JS array
  const data = outputTensor.data;
  const shape = outputTensor.dims; // [1,N,85]
  const results = [];
  if(shape.length<3) return results;
  const N = shape[1];
  const C = shape[2];
  for(let i=0;i<N;i++){
    const offset = i*C;
    const cx = data[offset+0]; const cy = data[offset+1]; const w = data[offset+2]; const h = data[offset+3];
    const objConf = data[offset+4];
    // class probs
    let cls = 0; let maxp = 0;
    for(let c=5;c<C;c++){ if(data[offset+c]>maxp){ maxp=data[offset+c]; cls=c-5; } }
    const score = objConf * maxp;
    if(score < confThreshold) continue;
    // coordinates are on the input size (letterboxed). Convert to original video pixel coords
    const x1 = (cx - w/2 - padInfo.dx)/padInfo.scale;
    const y1 = (cy - h/2 - padInfo.dy)/padInfo.scale;
    const x2 = (cx + w/2 - padInfo.dx)/padInfo.scale;
    const y2 = (cy + h/2 - padInfo.dy)/padInfo.scale;
    results.push({box:[x1,y1,x2,y2], score, class:cls});
  }
  // sort by score desc and NMS
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
