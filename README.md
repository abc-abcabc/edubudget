# EduBudget · 연구회 운영비 관리

여러 연구회의 운영비 예산·사용 내역·잔액을 PC와 모바일에서 관리하는 웹앱입니다.

- 정적 사이트 (HTML/CSS/JS, 빌드 과정 없음) → Vercel 배포
- Firebase Authentication (Google 로그인) + Cloud Firestore 저장
- 데이터 구조: `users/{uid}/groups/{groupId}` — 연구회 1개 = 문서 1개 (예산 항목 `items`, 사용 내역 `expenses` 포함)
- 로그인한 사용자는 본인 데이터만 접근 가능 (`firestore.rules`)

## Firebase 설정

1. Firebase 콘솔 → **Authentication → 로그인 방법 → Google** 사용 설정
2. **Firestore Database** 생성 후 **규칙** 탭에 `firestore.rules` 내용 붙여넣고 게시
3. **Authentication → 설정 → 승인된 도메인**에 Vercel 도메인(예: `edubudget.vercel.app`) 추가
4. `firebase-config.js`에 웹 앱 설정값 입력

## 로컬 실행

ES 모듈을 사용하므로 파일을 직접 열지 말고 로컬 서버로 실행하세요.

```bash
npx serve .
```
