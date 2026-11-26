# 공개 설치·커뮤니티 제출 준비

2026-11-26 · 0.16.0 준비 브랜치. 현재 정식 공개본은 0.15.0이다. 스토어 승인·등록 완료 문서가 아니다.

## 확인한 공식 요건

- [제출 방법](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin): 현재는 obsidian-releases 저장소 PR이 아니라 community.obsidian.md에서 Obsidian 계정 로그인·GitHub 연결 후 제출한다. default branch의 manifest를 읽는다. 버전과 같은 이름의 태그 및 개별 main.js/manifest.json/styles.css 첨부가 필요하다. 기존 `v0.15.0` 전체 ZIP만으로는 새 공식 설치 경로를 충족하지 않는다.
- [개발자 정책](https://docs.obsidian.md/community-directory/developer-policies): 플러그인의 자체/의존성 설치·업데이트 금지. 라이선스와 네트워크·계정·Vault 외부 접근 고지 필요.
- 사용자가 MIT 배포를 선택하여 루트 LICENSE 추가. 모델 가중치 라이선스까지 MIT로 바꾸지 않는다.

## 적용한 변경

1. 사용자 안내와 개발자 빌드 설명을 분리. 설치·개인정보·계정·네트워크·외부 파일 위치를 공개 문서에 명시.
2. 스토어 세 파일과 별도 사용자 실행 지원 패키지 분리 빌더 추가. `npm run check`, `npm run package:distribution` 실행.
3. 플러그인은 같은 버전의 외부 지원 디렉터리를 우선 탐색하고, 호환되는 기존 전체 ZIP의 worker/native도 유지한다. 미설치 상태를 안내하며 자체 다운로드·설치·업데이트는 하지 않는다.
4. 별도 지원 설치기는 체크섬 검증 후 버전별 디렉터리에 복사한다. 같은 대상이 다른 내용이면 중단하고 기존 회의·모델·설정을 건드리지 않는다. --dry-run은 파일을 설치하지 않는다. Python·모델은 이 설치기가 설치하지 않는다.
5. 세 파일만 설치돼도 라이선스 고지를 잃지 않도록 JS 번들에 MIT 및 UI 의존성 고지를 포함.
6. 루트 manifest/package/lock/versions.json을 0.16.0 개발 준비 상태로 일치시킨다. 아직 0.16.0 릴리즈·태그는 발행하지 않았다. 기존 정식 0.15.0 자산은 수정하지 않는다.

## 설치 구성

```text
Obsidian Community → main.js + manifest.json + styles.css
사용자 직접 설치 → ~/Library/Application Support/obsidian-local-meeting/
  runtime/
    support/0.16.0/worker + native + 라이선스 + 변환 도구
    .venv/                 # 별도 준비 필요
    .venv-community/       # 별도 준비 필요
    models/                # 별도 준비 필요
```

외부 설치기를 분리했다는 사실만으로 정책 승인이 보장되지는 않는다. 제출 시 로컬 실행 의존성과 설치 방식·지원 플랫폼을 분명히 설명하고 심사 피드백을 따른다.

## 제출 전 남은 필수 작업

- 공식 ESLint 권장 검사에서 기존 소스의 타입/Promise/DOM/스타일/단축키 항목을 발견했다. 검사 규칙을 끄거나 성공으로 위장하지 않는다. 전체 권장 결과는 실제 새 테스트 결과와 별도로 보고한다. 커뮤니티 서버의 scanner 설정과 로컬 recommended 전체 설정은 동일하지 않으며 로컬 권장 오류 전체가 서버의 거절 수를 의미하지는 않는다.
- 검사기 개발 의존성에서 npm audit의 moderate 경고가 나타났다. 강제 수정으로 공식 검사기를 오래된 버전으로 내리지 않았다. 런타임 번들에 이 검사기를 넣지 않지만 배포 전 개발 도구 의존성 처리도 필요하다.
- Python/모델의 신규 사용자 설치 단계가 남아 있다. 서명·공증한 별도 엔진 설치 도구와 새 Mac에서의 처음 설치/다른 Vault/업데이트·복구 시험이 필요하다. 로컬에서 설치기 --dry-run이 성공했다고 새 Mac STT 설치 완료로 주장하지 않는다.
- Community-1 이용 동의와 Hugging Face 인증은 사용자가 직접 진행해야 한다. 브라우저/계정 접근·이용 약관 동의 자동화로 우회하지 않는다.
- 브라우저 ChatGPT 인증을 타 사용자도 지원받을 수 있는지 별도 공개 배포 적합성 확인이 필요하다. 이 Mac에서의 기존 성공만으로 모든 계정의 지원을 보증하지 않는다.
- 계정 소유자가 community.obsidian.md에 로그인하고 organic4597 GitHub 계정을 연결해야 한다. 실제 제출 전 위 코드/설치 조건과 새 릴리즈를 갖춘다. 제출 후 자동/수동 심사와 승인까지는 별도 상태다.

## 제출용 설명 초안

Name: Local Meeting
Repository: organic4597/obsidian-local-meeting
Description: Record and transcribe Korean meetings locally, identify speakers, and optionally organize summaries, tasks, and calendar events.
Platform: Desktop only; Apple Silicon macOS 15+; separate local runtime and models required.
License: MIT (third-party code and models retain their own terms).
Network/account: Optional OpenAI text processing requires account access; local audio and speaker features are not sent to OpenAI. Model acquisition requires separate provider access as applicable.

현재 이 문서는 등록 신청서 초안이며 제출 영수증이 아니다.
