# 다른 Mac에 설치하기

현재 지원: Apple Silicon Mac / macOS 15+ / Obsidian 1.11.4+. Windows·Linux·Intel Mac·모바일용 배포가 아니다.

## 공개 배포 준비 상태

현재 정식 0.15.0은 GitHub의 전체 ZIP으로 설치한다. 커뮤니티 디렉터리에는 아직 등록되지 않았다. `community`의 세 파일과 별도 지원 패키지는 0.16.0 개발 브랜치에서 검증 중이며, 아래 절차가 전부 자동화된 상태는 아니다.

## 기존 정식 ZIP 설치

1. https://github.com/organic4597/obsidian-local-meeting/releases/latest 에서 macOS arm64 전체 ZIP을 받는다. GitHub의 Source code ZIP은 설치 파일이 아니다.
2. Obsidian을 종료하고 ZIP의 `local-meeting` 폴더를 `<Vault>/.obsidian/plugins/`에 복사한다. 업데이트할 때는 기존 `data.json`과 `local-runtime.json`을 보존한다.
3. Obsidian → 커뮤니티 플러그인에서 Local Meeting을 활성화한다.
4. 아래 Python·모델을 한 번 준비한다. 기존에 같은 Mac에 설치했다면 자동 연결한다.

## 스토어용 분리 설치 구성 (개발 중)

스토어는 JS·manifest·CSS만 설치한다. 지원 패키지는 사용자가 GitHub에서 따로 받아 압축을 풀고 `Install Local Meeting Support.command`를 직접 실행한다. 이 도구는 파일 체크섬을 검사한 뒤 같은 버전의 worker/native 파일을 사용자 앱 데이터 폴더로 복사한다. 기존 버전·회의·설정·모델을 삭제하거나 네트워크에서 의존성을 설치하지 않는다. 기존 대상이 다른 내용이면 덮어쓰지 않고 중단한다. 플러그인에는 설치기 자동 실행 기능이 없다.

검증만 하려면 터미널에서 `bash 'Install Local Meeting Support.command' --dry-run`을 실행한다. 이 파일은 Apple 공증 설치 프로그램이 아니며, 실제 공개 배포 전 서명·공증 설치 UX를 검토해야 한다.

## Python·모델 준비 (한 번 필요)

현재 신규 사용자의 가장 큰 남은 단계다. Python 3.11 환경 두 개와 ASR·화자·정렬 모델을 준비한다. Python/모델의 완전 자동 설치기는 아직 제공하지 않는다. 개발용 Node.js·Swift 컴파일러는 빌드된 배포 파일을 쓰는 사용자에게 필요하지 않다.

- ASR 환경: `worker/requirements.txt`. 한국어 원본 `TeamUNIVA/qwen3_asr_1.7b_ko`를 내려받고 저장소 `scripts/prepare_model.py`로 MLX 8비트 변환.
- 화자 분석 환경: 별도 가상환경에 `worker/requirements-community.txt`. `pyannote/speaker-diarization-community-1` 공식 페이지의 이용 조건 확인·동의와 Hugging Face 인증은 사용자가 직접 한다.
- 단어 정렬: 기존 워커와 호환되는 로컬 ForcedAligner 모델이 필요하다. [로컬 엔진 연결](LOCAL-RUNTIME.ko.md)의 폴더 구성 또는 설치 정보 파일을 사용한다.
- 가중치나 인증 토큰을 Vault나 GitHub에 올리지 않는다. 모델별 라이선스는 플러그인의 MIT와 별개다.

설치된 Python·모델은 설정의 ‘자동으로 다시 연결’로 탐색한다. 준비되지 않은 항목이 있으면 일반 설정에서 필요한 종류를 확인하고, 별도 경로는 고급 문제 해결에서 연결한다.

## 권한·계정·네트워크

녹음/STT/화자는 로컬 처리한다. 마이크·시스템 오디오·Mac 캘린더 접근은 해당 기능의 macOS 권한이 필요하다. 캘린더는 이 Mac에 연결된 계정을 사용한다.

AI 요약은 선택 사항이다. ChatGPT 계정 연결이 필요하며 계정의 사용 권한·한도가 적용된다. 실행하면 현재 회의 텍스트와 필기를 OpenAI로 전송하고 오디오는 보내지 않는다. 로컬 전사에는 OpenAI 계정이 필요하지 않다. [개인정보 안내](PRIVACY.ko.md)를 참고한다.
