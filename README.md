# Motion Tracker (YOLO ONNX) — 간단 가이드

이 프로젝트는 모바일 웹에서 동영상의 움직이는 물체를 선택하고 운동을 분석하기 위한 샘플 애플리케이션입니다. 주요 기능은 다음과 같습니다:

- 비디오 업로드, 카메라 실시간 촬영
- 화면 터치/드래그로 ROI 선택
 - YOLO(ONNX) 모델 연동(선택) — 프로젝트 루트의 `yolov8n.onnx` 파일을 사용하도록 기본 설정되어 있습니다
- 프레임별 좌표 추출, 속도/가속도 계산, 궤적 시각화
- 결과 CSV 내보내기

주의사항
- ONNX 기반 YOLO 모델을 웹에서 사용하려면 간단한 HTTP 서버로 파일(특히 모델)을 제공해야 합니다. 로컬 파일 시스템(file://)에서는 CORS/로딩 문제가 발생합니다.
- 모바일에서 카메라 및 파일 접근 권한을 허용해야 합니다.

빠른 시작

1. 모델 파일 준비 (선택)
   - 기본 설정은 프로젝트 루트에 `yolov8n.onnx` 파일을 두는 것입니다. 다른 위치에 두려면 `app.js`에서 `modelPath`를 수정하세요.
   - 모델은 NMS 비활성화 형식(출력 [1,N,85])로 내보낸 YOLOv8 ONNX를 가정합니다.

2. 간단한 HTTP 서버로 제공
   - Python이 설치된 경우 (권장)
     - PowerShell에서 프로젝트 폴더(이 파일이 있는 폴더)로 이동
     - `python -m http.server 8000` 실행
   - 또는 VS Code Live Server 확장 사용

3. 브라우저에서 열기
   - 모바일: 같은 네트워크에서 호스트의 IP:포트(예: `http://192.168.0.10:8000`)로 접속
   - 데스크탑: `http://localhost:8000` 접속

모델이 없을 때
- YOLO 모델이 없거나 로드 실패 시에는 ROI 기반의 수동 분석(선택한 영역의 중심 추적)을 사용할 수 있습니다.

성능 및 한계
- 브라우저 환경에서 ONNX/YOLO를 실행하는 것은 모바일 성능에 제약을 받을 수 있습니다. 경량 모델(예: yolov8n)을 사용하고, 분석 프레임레이트를 낮게 설정하면 더 안정적입니다.
- 모델 변환/추출 방법 및 정확한 ONNX 출력 형태는 사용하는 환경(ultralytics 버전 등)에 따라 다릅니다. 필요하면 모델 변환 스크립트 예시를 추가해 드립니다.

다음 단계 제안
- 추적 안정성 향상: SORT 또는 ByteTrack을 포팅
- 실시간 추적(비디오 재생 중): WebGL/Worker로 처리
- UI 개선: 분석 구간 선택, 슬로우 모션, 확대/축소

## GitHub Pages(예: github.io)로 배포하기

이 프로젝트는 정적 웹 앱이므로 GitHub Pages로 배포하기에 적합합니다. 권장 배포 방식과 주의사항은 다음과 같습니다.

- 권장 파일 구조 (프로젝트 루트에서):

   Traker/ (현재 폴더)
      - index.html
      - styles.css
      - app.js
      - yolov8n.onnx  <-- 모델 파일 (프로젝트 루트)
      - README.md

   GitHub Pages로 배포하려면 이 전체 `Traker/` 폴더를 레포지토리의 `docs/` 폴더로 옮기거나(간단) 레포지토리 루트에 둔 다음 Pages 설정에서 `gh-pages` 브랜치나 `docs/`를 소스로 지정하세요.

- 배포 절차 (간단)
   1. 로컬에서 변경 사항 커밋
   2. `Traker/` 폴더 전체를 레포지토리의 `docs/`로 복사하거나 `gh-pages` 브랜치로 복사
   3. GitHub 레포에서 Settings → Pages 에서 소스(Source)를 `main/docs` 또는 `gh-pages`로 설정
   4. 페이지가 퍼블리시되면 `https://<your-user>.github.io/<repo-name>/Traker/` 또는 `https://<your-user>.github.io/`에서 접근 가능

- 모델 파일 관련 주의사항
   - 모델 파일(`yolov8n.onnx`)은 리포지토리에서 정적 파일로 제공되므로 CORS 문제 없이 브라우저에서 직접 fetch로 로드할 수 있습니다.
   - 파일 크기가 커서(>100MB) GitHub 저장소 한 파일 제한을 초과하면 Git LFS 사용 또는 외부 스토리지(예: S3)를 고려하세요.
   - 모델을 바꾸려면 프로젝트 루트의 `yolov8n.onnx`를 교체하거나 `app.js`의 `modelPath` 값을 조정하세요.

- 성능/보안 팁
   - GitHub Pages는 HTTPS이므로 onnxruntime-web WebGL/WASM을 안전하게 사용 가능합니다.
   - 모바일 브라우저에서 모델 로딩이 느리면 더 작은 모델(예: yolov8n) 사용, 또는 서버 사이드 추론(endpoints)을 고려하세요.
