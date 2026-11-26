// spaceLog 데모 실행기: 가짜 데이터가 든 별도 폴더로 진짜 서버를 띄워 화면 · 기능을 점검한다.
//   npm run demo             웹을 빌드하고 http://127.0.0.1:4848 에 띄운다(처음이면 데이터를 심는다)
//   npm run demo -- --reset  데모 폴더(~/spaceLog-demo)만 지우고 다시 심는다
// 실제 데이터 폴더(~/spaceLog)와 개발 포트(4747 · 4748 · 5173)는 건드리지 않는다.
// 챗봇은 저장소 루트 .env 의 같은 OpenAI 키를 쓴다(이 스크립트는 키를 읽지 않는다).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';

// ───────────────────────── 심을 데이터(여기만 고치면 된다) ─────────────────────────
// 행성. key 는 아래 별이 가리키는 이름. 미분류(unsorted)는 서버가 늘 만든다.
// color_index 1~16, deco: town crystal forest rock ice volcano mushroom cactus flower cloud
const PLANETS = [
  { key: 'ai', name: '원티드 AI 교육', description: '부트캠프 수업과 과제', color_index: 6, deco: 'crystal', ring: true },
  { key: 'book', name: '독서 노트', description: '밑줄과 생각', color_index: 11, deco: 'forest', ring: false },
  { key: 'trip', name: '여행 계획', description: '제주 · 부산', color_index: 3, deco: 'flower', ring: true },
  { key: 'daily', name: '일상기록', description: '오늘 있었던 일', color_index: 9, deco: 'town', ring: false },
  { key: 'idea', name: '일 아이디어', description: '언젠가 해 볼 것', color_index: 14, deco: 'cloud', ring: false },
  { key: 'gym', name: '운동', description: '러닝 · 헬스', color_index: 2, deco: 'volcano', ring: false },
  { key: 'movie', name: '영화 · 드라마', description: '아직 비어 있음', color_index: 12, deco: 'mushroom', ring: false }, // 빈 행성
];

// 이미지 · 파일은 코드로 만든다. png: [위 색 r,g,b, 아래 색 r,g,b] 세로 그라데이션(크기 w × h).
const png = (name, top, bottom, w = 240, h = 160) => ({ name, png: { top, bottom, w, h } });
const txt = (name, text) => ({ name, text });

const LONG_RETRO = [
  '3주차를 마치며 정리해 두는 회고.',
  '',
  '처음 이 과정을 시작할 때는 "AI 서비스를 만든다"는 말이 막연했다. 모델을 직접 학습시키는 일인지, 남이 만든 모델을 가져다 쓰는 일인지도 헷갈렸다. 3주가 지나고 나니 적어도 내가 이번 과정에서 하게 될 일의 모양은 보인다. 대부분은 이미 있는 모델을 잘 불러 쓰고, 그 앞뒤에 내 데이터와 화면을 붙이는 일이다.',
  '',
  '1주차는 파이썬 복습과 Flask였다. 라우트를 만들고 JSON을 돌려주는 것까지는 금방 했는데, 에러가 났을 때 어디서 났는지 읽는 게 생각보다 어려웠다. 트레이스백을 맨 아래부터 읽으라는 강사님 말이 제일 도움이 됐다. 과제로 만든 메모 API는 아직 테스트가 하나도 없다. 다음 주에는 pytest로 최소한 생성 · 조회 두 개는 붙여 보기로.',
  '',
  '2주차는 임베딩과 벡터 검색. 문장을 숫자 배열로 바꾸고 가까운 것을 찾는다는 개념 자체는 이해했지만, 왜 조각 크기에 따라 답이 그렇게 달라지는지는 실습을 하고 나서야 감이 왔다. 조각을 너무 크게 자르면 엉뚱한 문단까지 같이 딸려 오고, 너무 작게 자르면 앞뒤 맥락이 사라진다. 우리 조는 500자 안팎에 겹침 50자로 정했다.',
  '',
  '3주차는 RAG를 처음부터 끝까지 붙여 봤다. 문서를 읽고, 자르고, 임베딩하고, 질문이 오면 비슷한 조각을 찾아 프롬프트에 넣는다. 말로 하면 다섯 줄인데 실제로는 파일 인코딩, 빈 문서, 너무 긴 표 같은 데서 계속 막혔다. 그래도 내 노트에 대해 질문했을 때 내가 적은 문장을 근거로 답이 나오는 걸 처음 봤을 때는 꽤 짜릿했다.',
  '',
  '조 프로젝트 이야기도 남겨 둔다. 우리 조는 네 명이고, 기획 하나, 디자인 하나, 개발 둘이다. 첫 회의에서 주제 후보를 세 개 냈는데, 결국 "개인 기록을 검색해 주는 챗봇"으로 기울고 있다. 데이터를 따로 구할 필요 없이 각자 쓰던 메모로 바로 실험해 볼 수 있다는 점이 컸다. 걱정되는 건 개인 기록이 밖으로 나가는 문제다. 어떤 내용이 OpenAI로 보내지는지 화면에서 분명하게 보여 주고, 사용자가 행성 단위로 빼 둘 수 있게 하자는 의견이 나왔다.',
  '',
  '강의 밖에서 배운 것도 있다. 질문을 잘게 쪼개서 검색해 보는 습관이 생겼고, 공식 문서를 먼저 열어 보는 일이 늘었다. 예전에는 블로그 글부터 찾았는데, 버전이 달라서 코드가 안 돌아가는 일을 몇 번 겪고 나니 문서가 제일 빠르다는 걸 알게 됐다.',
  '',
  '잘한 점: 매일 수업이 끝나면 그날 배운 걸 세 줄로 남겼다. 이번 주 수업 요약을 쓸 때 그 메모가 그대로 재료가 됐다. 조 프로젝트 회의록도 빠짐없이 남기고 있다.',
  '',
  '아쉬운 점: 모르는 걸 바로 묻지 않고 혼자 붙잡고 있다가 두 시간을 날린 날이 있었다. 30분 넘게 막히면 질문하기로 규칙을 정했다. 그리고 수면 시간이 무너졌다. 새벽 두 시에 짠 코드는 다음 날 거의 다 다시 썼다.',
  '',
  '다음 주 목표',
  '- Flask 과제에 테스트 두 개 붙이기',
  '- RAG 실습 코드에서 조각 크기를 바꿔 가며 답 비교해 보기',
  '- 팀 프로젝트 주제 확정하고 역할 나누기',
  '- 밤 12시 전에 노트북 닫기',
  '',
  '한 달 뒤의 나에게: 지금 헷갈리는 것들도 언젠가는 당연해진다. 그때 이 메모를 다시 읽어 보자.',
].join('\n');

// 별. p = 행성 key(없으면 미분류), d = 며칠 전(0 = 오늘), t = 'HH:MM'(오늘인데 아직 안 된 시각이면 지금보다 조금 전으로)
// title 이 없으면 서버가 본문 첫 줄 · 파일 이름 · 링크 제목으로 정한다. key 는 대화 기록의 출처로 쓴다.
const STARS = [
  // ── 미분류(25) ──
  { d: 0, t: '09:12', title: '이번 주 할 일', body: '- Flask 과제 테스트 붙이기\n- 팀 회의 안건 정리\n- 제주 렌터카 확정\n- 도서관 책 반납 (금)' },
  { d: 0, t: '13:40', links: ['https://developer.mozilla.org/ko/docs/Web/JavaScript'] },
  { d: 0, t: '15:05', title: '화이트보드 사진', files: [png('whiteboard.png', [235, 238, 242], [190, 198, 210])] },
  { d: 1, t: '12:10', title: '점심 메뉴 후보', body: '순두부, 쌀국수, 김밥천국. 비 오면 무조건 순두부.' },
  { d: 1, t: '19:30', title: '이번주 장보기', body: '계란 한 판\n두부 2모\n양파, 대파\n우유\n세탁 세제' },
  { d: 2, t: '22:15', title: 'SQLite FTS5 문서 나중에 읽기', links: ['https://www.sqlite.org/fts5.html'] },
  { d: 3, t: '08:50', title: '맥에서 저장한 메모'.normalize('NFD'), body: '맥북에서 옮겨 온 메모예요. 제목이 NFD(자모 분리) 한글로 저장돼 있어서 검색이 되는지 확인하는 용도.' },
  { d: 3, t: '17:20', files: [txt('스크린샷 정리 목록.txt', '2026-11 스크린샷 정리\n- 수업 슬라이드 12장 → AI 교육 폴더\n- 영수증 4장 → 가계부\n- 밈 7장 → 삭제\n')] },
  { d: 4, t: '21:00', title: '공유기 펌웨어 업데이트하기', body: '관리 페이지 들어가서 업데이트만 누르면 됨. 10분 정도 인터넷 끊김.' },
  { d: 5, t: '10:05', title: 'Quick note: 발표 자료 폰트 체크', body: 'Pretendard로 통일. Title은 Bold, body는 Regular. 영어 단어는 font fallback 확인할 것.' },
  { d: 6, t: '18:42', title: '퇴근길 하늘', files: [png('노을.png', [252, 140, 90], [88, 60, 140])] },
  { d: 7, t: '23:10', title: '읽을거리', links: ['https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)', 'https://docs.python.org/3/library/sqlite3.html'] },
  { d: 8, t: '11:30', title: '전화할 곳', body: '치과 예약 변경\n관리사무소 (택배함)\n엄마' },
  { d: 9, t: '00:20', title: '생각 조각', body: '기록은 많이 하는데 다시 꺼내 보질 않는다. 찾기 쉬워야 다시 본다.' },
  { d: 10, t: '20:15', files: [txt('영수증 정리.csv', '날짜,가게,금액\n2026-11-14,편의점,4800\n2026-11-15,서점,16200\n2026-11-15,카페,5500\n2026-11-16,마트,32900\n')] },
  { d: 12, t: '09:40', title: '택배 반품 접수', body: '사이즈 안 맞는 운동화. 수거 기사님 목요일 방문.' },
  { d: 13, t: '14:25', title: 'HTTP 상태 코드 표', links: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/Status'] },
  { d: 15, t: '07:55', title: '아이디어: 습관 앱', body: '체크만 하는 습관 앱 말고, 왜 빼먹었는지 한 줄 적게 하는 앱.' },
  { d: 17, t: '13:05', title: '카페 메뉴판', files: [png('cafe-menu.png', [120, 84, 60], [230, 210, 180], 200, 260)] },
  { d: 19, t: '16:45', title: 'Flask 에러 메시지 메모', body: 'werkzeug.exceptions.BadRequest: 400 Bad Request\n→ request.json 을 읽을 때 Content-Type 이 application/json 이 아니면 난다.\n→ 프런트에서 headers 빠뜨린 것이 원인.' },
  { d: 21, t: '21:30', title: '선물 리스트', body: '동생: 무선 이어폰 케이스\n아빠: 등산 양말\n친구 집들이: 디퓨저' },
  { d: 24, t: '22:00', title: '지난주 회고 한 줄', body: '계획은 많았고 한 건 절반. 그래도 매일 기록은 했다.' },
  { d: 27, t: '10:10', title: '오래된 메모', body: '버스 카드 충전하기' },
  { d: 30, t: '15:30', title: '주소 복사해 둔 것', links: ['https://ko.wikipedia.org/wiki/서울특별시'] },
  { d: 34, t: '20:00', title: '첫 메모', body: 'spaceLog 처음 써 봄. 아무거나 일단 띄워 두기.' },

  // ── 원티드 AI 교육(16) ──
  { key: 'rag3', p: 'ai', d: 0, t: '10:30', fav: true, title: 'RAG 실습 3일차', body: '오늘 한 것\n1. 내 노트 20개를 500자 조각으로 자르기 (겹침 50자)\n2. text-embedding-3-small 로 임베딩\n3. 질문과 코사인 유사도 상위 4개를 프롬프트에 넣기\n\n배운 점: 조각이 너무 길면 엉뚱한 문단이 같이 딸려 온다. 출처를 같이 보여 주니 답을 믿기가 훨씬 쉽다.' },
  { p: 'ai', d: 1, t: '20:40', title: 'LangChain Retriever 정리 (Retriever basics)', body: 'Retriever = 질문을 받아 문서 목록을 돌려주는 것.\nVectorStoreRetriever 의 search_kwargs={"k": 4} 로 개수 조절.\nMMR 은 비슷한 조각이 겹치지 않게 골라 준다.' },
  { key: 'ragmd', p: 'ai', d: 2, t: '16:00', fav: true, title: 'RAG 파이프라인 노트', files: [txt('RAG 파이프라인 정리.md', '# RAG 파이프라인 정리\n\n## 1. 읽기\n- PDF · 메모 · 웹 문서를 글로 바꾼다\n\n## 2. 자르기\n- 500자, 겹침 50자\n\n## 3. 임베딩\n- text-embedding-3-small (1536차원)\n\n## 4. 찾기\n- 코사인 유사도 상위 k=4\n\n## 5. 답하기\n- 찾은 조각만 보고 답하게 하고, 없으면 "모른다"고 말하게 한다\n')] },
  { p: 'ai', d: 3, t: '09:15', title: 'Retrieval-augmented generation 위키', links: ['https://en.wikipedia.org/wiki/Retrieval-augmented_generation'] },
  { key: 'weeksum', p: 'ai', d: 4, t: '18:30', fav: true, title: '이번 주 수업 요약', body: '월: 임베딩 개념, 벡터 검색\n화: 조각 나누기 실습\n수: RAG 처음부터 끝까지 붙이기\n목: 프롬프트에 출처 넣기, 환각 줄이기\n금: 조별 중간 점검\n\n한 줄 요약: 모델보다 데이터를 어떻게 자르고 넣느냐가 답의 질을 좌우한다.' },
  { key: 'flask', p: 'ai', d: 5, t: '23:50', title: 'Flask 과제 제출본', body: '메모 CRUD API. 제출 전 체크: requirements 고정, README 실행 방법.', files: [
    txt('flask_app.py', 'from flask import Flask, jsonify, request\n\napp = Flask(__name__)\nmemos = []\n\n@app.post("/memos")\ndef create_memo():\n    memo = {"id": len(memos) + 1, "text": request.json["text"]}\n    memos.append(memo)\n    return jsonify(memo), 201\n\n@app.get("/memos")\ndef list_memos():\n    return jsonify(memos)\n'),
    txt('README.md', '# 메모 API (Flask 과제)\n\n```\npip install -r requirements.txt\nflask --app flask_app run\n```\n'),
    txt('requirements.txt', 'flask==3.1.0\npytest==8.3.3\n'),
  ] },
  { p: 'ai', d: 6, t: '14:10', title: '임베딩 차원 질문', body: 'text-embedding-3-small 은 1536차원. dimensions 인자로 줄일 수 있다는데 성능 차이는? → 다음 수업 때 질문하기.' },
  { key: 'retro', p: 'ai', d: 8, t: '22:40', fav: true, title: '3주차 회고', body: LONG_RETRO },
  { p: 'ai', d: 9, t: '11:00', title: 'Flask 공식 문서', links: ['https://flask.palletsprojects.com/en/stable/'] },
  { p: 'ai', d: 10, t: '15:20', title: '아키텍처 다이어그램', body: '조 프로젝트 초안. 화면 → API → 검색 → LLM.', files: [png('architecture.png', [30, 40, 80], [70, 110, 180]), txt('architecture-notes.txt', '화면(웹) → Flask API → 벡터 검색 → OpenAI\n저장: SQLite + 파일 폴더\n')] },
  { p: 'ai', d: 12, t: '19:05', title: '프롬프트 엔지니어링 팁', body: '- 역할을 먼저 준다\n- 예시를 한두 개 보여 준다\n- 모르면 모른다고 말하게 한다\n- 출력 형식을 정해 준다 (목록, JSON 등)' },
  { p: 'ai', d: 14, t: '21:20', title: 'Python 튜토리얼 복습', links: ['https://docs.python.org/3/tutorial/index.html'] },
  { p: 'ai', d: 16, t: '17:45', title: '팀 프로젝트 주제 후보', body: '1. 개인 기록 검색 챗봇\n2. 강의 자료 요약기\n3. 채용 공고 비교 도우미\n→ 1번이 제일 끌림. 데이터 구하기 쉬움.' },
  { p: 'ai', d: 20, t: '09:30', title: 'OT 날', body: '원티드 AI 교육 첫날. 12주 과정, 마지막 2주는 팀 프로젝트. 같은 조 4명과 인사.' },
  { p: 'ai', d: 23, t: '20:10', title: '파이썬 리스트 컴프리헨션', body: 'squares = [x * x for x in range(10) if x % 2 == 0]\n딕셔너리도 됨: {k: v for k, v in pairs}' },
  { p: 'ai', d: 28, t: '13:50', title: '과제 채점 기준', body: '동작 40, 코드 읽기 쉬움 30, README 20, 테스트 10.' },

  // ── 독서 노트(7) ──
  { key: 'book1', p: 'book', d: 1, t: '23:20', fav: true, title: '『데미안』 밑줄', body: '자기 안에서 솟아나는 것을 따라 살려는 것, 그게 왜 그렇게 어려운가에 대한 이야기.\n싱클레어가 데미안을 만나며 "착한 아이"의 세계 밖으로 나오는 장면이 제일 기억에 남는다.' },
  { key: 'book2', p: 'book', d: 4, t: '22:30', title: '『아주 작은 습관의 힘』 메모', body: '목표보다 시스템. 1%씩 나아지면 1년 뒤 37배.\n습관을 쉽게 만들려면 보이게, 쉽게, 만족스럽게.\n→ 러닝화를 현관 앞에 꺼내 두기 시작함.' },
  { p: 'book', d: 9, t: '12:40', title: '읽고 싶은 책', body: '- 『클린 코드』\n- 『사피엔스』 (읽는 중)\n- 『불편한 편의점』\n- 『프로젝트 헤일메리』' },
  { p: 'book', d: 13, t: '19:10', title: '책 표지 사진', files: [png('book-cover.png', [40, 90, 70], [200, 220, 160], 180, 260)] },
  { key: 'book3', p: 'book', d: 18, t: '21:45', title: '『사피엔스』 3장 정리', body: '수렵채집 시대의 사람들은 생각보다 다양한 음식을 먹고, 일하는 시간도 짧았을 수 있다는 주장.\n농업 혁명이 꼭 삶을 편하게 만든 건 아니었다는 관점이 새로웠다.' },
  { p: 'book', d: 25, t: '10:20', title: '한강 작가 위키', links: ['https://ko.wikipedia.org/wiki/한강_(작가)'] },
  { p: 'book', d: 31, t: '18:00', title: '독서 모임 일정', body: '매달 마지막 토요일 오후 3시, 동네 북카페.' },

  // ── 여행 계획(6) ──
  { key: 'jeju1', p: 'trip', d: 2, t: '21:10', fav: true, title: '제주 숙소 후보', body: '1. 애월 바다 앞 게스트하우스 (1박 6만)\n2. 서귀포 감귤밭 독채 (1박 11만)\n사진은 예약 사이트 캡처.', files: [png('jeju-aewol.png', [120, 200, 230], [20, 90, 150]), png('jeju-seogwipo.png', [250, 170, 60], [60, 130, 60])], links: ['https://ko.wikipedia.org/wiki/제주특별자치도'] },
  { key: 'jeju2', p: 'trip', d: 3, t: '22:05', title: '제주 준비물', body: '- 바람막이\n- 보조배터리\n- 선크림\n- 운동화 (오름 올라갈 것)\n- 신분증, 운전면허증\n- 상비약 (멀미약)' },
  { key: 'jeju3', p: 'trip', d: 7, t: '13:30', title: '항공권 비교', files: [txt('항공권 비교.csv', '항공사,출발,도착,왕복 가격\n제주항공,금 07:10,일 20:30,89000\n티웨이,금 08:05,일 21:10,76500\n대한항공,금 09:00,일 19:40,132000\n')] },
  { p: 'trip', d: 11, t: '10:00', title: '렌터카 예약 메모', body: '완전자차 필수. 공항 셔틀 타는 곳 3번 게이트.' },
  { p: 'trip', d: 20, t: '20:30', title: '부산 당일치기 코스', body: 'KTX 7시 → 해운대 → 청사포 다릿돌 전망대 → 광안리 저녁 → 막차' },
  { p: 'trip', d: 33, t: '23:00', title: '여행 가고 싶은 곳', body: '교토, 치앙마이, 강릉, 통영' },

  // ── 일상기록(7) ──
  { p: 'daily', d: 0, t: '08:05', title: '오늘 날씨 좋음', body: '아침 공기가 차갑지만 맑다. 걸어서 수업 감.' },
  { p: 'daily', d: 2, t: '18:20', fav: true, title: '산책길', files: [png('walk.png', [170, 210, 120], [60, 110, 70])] },
  { p: 'daily', d: 5, t: '23:30', title: '이번 주 기분 기록', body: '월 😐 화 🙂 수 😫 목 🙂 금 😄\n수요일은 과제 마감 때문에 최악.' },
  { p: 'daily', d: 9, t: '09:00', title: '동생 생일', body: '케이크 예약 완료. 저녁 7시 집.' },
  { p: 'daily', d: 14, t: '11:15', title: '대청소 체크리스트', body: '[x] 창틀\n[x] 냉장고\n[ ] 베란다\n[ ] 옷장 정리' },
  { p: 'daily', d: 22, t: '16:40', title: '카페 추천받은 곳', body: '역 앞 2층 카페, 창가 자리 콘센트 있음. 공부하기 좋다고 함.' },
  { p: 'daily', d: 29, t: '21:50', title: '이사 한 달 차', body: '이제 동네 길이 좀 익숙해졌다. 마트는 걸어서 5분, 도서관은 15분.' },

  // ── 일 아이디어(5) ──
  { p: 'idea', d: 1, t: '22:50', title: 'spaceLog에 태그 기능?', body: '행성 하나에 별이 너무 많아지면 태그로 한 번 더 나누고 싶을 듯. 근데 행성이 이미 분류라 겹칠 수도.' },
  { p: 'idea', d: 6, t: '15:35', title: '회의록 검색 도구 아이디어', body: '사내 회의록을 RAG로 검색하는 도구. "지난달 결정한 것" 같은 질문에 답하게.\nFlask로 API만 먼저 만들고 화면은 나중에.' },
  { p: 'idea', d: 10, t: '21:05', title: '주말 사이드 프로젝트', body: '동네 도서관 신착 도서 알림 봇. 크롤링 + 텔레그램.' },
  { p: 'idea', d: 16, t: '13:20', title: 'Notion 대신 쓸 정리법', body: '폴더는 3개만: 지금 하는 것, 언젠가, 끝난 것.' },
  { p: 'idea', d: 26, t: '19:40', title: '온보딩 개선 메모', body: '첫 화면에서 할 일을 하나만 보여 주기. 설명은 나중에.' },

  // ── 운동(5) ──
  { key: 'run', p: 'gym', d: 1, t: '07:10', fav: true, title: '러닝 5km', body: '5.02km, 29분 40초. 페이스 5\'55". 마지막 1km 숨참.' },
  { key: 'gymcsv', p: 'gym', d: 3, t: '21:40', files: [txt('운동 기록.csv', '날짜,종류,시간(분),메모\n2026-11-02,러닝,32,4.8km\n2026-11-05,헬스,50,하체\n2026-11-09,러닝,30,5.0km\n2026-11-12,헬스,45,등\n2026-11-16,러닝,35,5.5km\n2026-11-20,헬스,55,하체\n2026-11-23,러닝,31,5.0km\n')] },
  { p: 'gym', d: 8, t: '20:00', title: '스쿼트 자세 메모', body: '무릎이 발끝을 너무 넘지 않게. 엉덩이를 뒤로 빼면서 앉기. 시선은 정면.' },
  { p: 'gym', d: 15, t: '19:30', title: '헬스장 PT 상담', body: '10회 패키지 권유받음. 일단 보류하고 혼자 루틴 짜 보기.' },
  { p: 'gym', d: 32, t: '06:50', title: '운동 시작', body: '오늘부터 주 3회. 첫날은 걷기 30분.' },
];

// 대화 기록(API 를 부르지 않고 DB 에 바로 넣는다). ago = 지금부터 몇 시간 전. sources 는 별 key(파일 첨부면 { key, file: true }).
const CONVERSATIONS = [
  {
    ago: 76, unread: false,
    messages: [
      { q: '최근에 읽은 책에서 기억할 만한 내용 알려 줘',
        a: '최근 독서 노트에서 기억할 만한 내용은 이래요.\n- 『데미안』: 자기 안에서 솟아나는 것을 따라 살려는 게 왜 어려운지에 대한 이야기로 적어 두셨어요. 싱클레어가 "착한 아이"의 세계 밖으로 나오는 장면이 가장 기억에 남는다고 하셨어요.\n- 『아주 작은 습관의 힘』: 목표보다 시스템, 1%씩 나아지면 1년 뒤 37배라는 메모가 있고, 그래서 러닝화를 현관 앞에 꺼내 두기 시작하셨어요.\n- 『사피엔스』 3장: 농업 혁명이 꼭 삶을 편하게 만든 건 아니었다는 관점이 새로웠다고 적으셨어요.',
        sources: ['book1', 'book2', 'book3'] },
    ],
  },
  {
    ago: 50, unread: false,
    messages: [
      { q: '이번 주 RAG 수업에서 뭐 배웠는지 정리해 줘',
        a: '이번 주 수업은 RAG를 처음부터 끝까지 붙여 보는 흐름이었어요.\n- 월·화: 임베딩과 벡터 검색, 조각 나누기 실습\n- 수: 문서를 500자 조각(겹침 50자)으로 자르고 text-embedding-3-small로 임베딩한 뒤, 질문과 비슷한 상위 4개 조각을 프롬프트에 넣는 실습\n- 목: 프롬프트에 출처를 넣어 환각을 줄이는 방법\n배운 점으로는 조각이 너무 길면 엉뚱한 문단이 같이 딸려 오고, 출처를 함께 보여 주면 답을 믿기 쉬워진다고 적어 두셨어요.',
        sources: ['weeksum', 'rag3', { key: 'ragmd', file: true }] },
    ],
  },
  {
    ago: 26, unread: false,
    messages: [
      { q: '제주 여행 준비물 뭐 적어 뒀어?',
        a: '제주 준비물로 적어 두신 건 이래요.\n- 바람막이\n- 보조배터리\n- 선크림\n- 운동화(오름 올라갈 것)\n- 신분증, 운전면허증\n- 상비약(멀미약)',
        sources: ['jeju2'] },
      { q: '항공권은 어디가 제일 쌌어?',
        a: '항공권 비교표에서는 티웨이가 왕복 76,500원으로 가장 쌌어요. 금요일 08:05 출발, 일요일 21:10 도착이에요. 그다음은 제주항공 89,000원, 대한항공 132,000원 순이에요.',
        sources: [{ key: 'jeju3', file: true }] },
      { q: '숙소는 예약 확정했어?',
        a: '기록에서 찾지 못했어요.',
        sources: [] },
    ],
  },
  {
    ago: 2, unread: true, // 안 읽은 대화
    messages: [
      { q: '이번 달 운동 기록 요약해 줘',
        a: '이번 달 운동 기록을 보면 러닝과 헬스를 번갈아 하셨어요.\n- 러닝 4번: 4.8km, 5.0km, 5.5km, 5.0km (30~35분)\n- 헬스 3번: 하체 두 번, 등 한 번 (45~55분)\n- 가장 최근에는 5.02km를 29분 40초에 뛰셨고, 마지막 1km에서 숨이 찼다고 적어 두셨어요.',
        sources: [{ key: 'gymcsv', file: true }, 'run'] },
    ],
  },
];
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 4848;
const RAG_PORT = 4849;
const BASE = `http://${HOST}:${PORT}`;
const HOME = os.homedir();
const DEMO_DIR = path.join(HOME, 'spaceLog-demo');
const MARKER = path.join(DEMO_DIR, '.demo-seeded');
const reset = process.argv.includes('--reset');

const log = (...a) => console.log('[demo]', ...a);
const fail = (msg) => {
  console.error(`[demo] ${msg}`);
  process.exit(1);
};

// 데모 폴더만 지운다. 이름이 spaceLog-demo 가 아니거나 실제 데이터 폴더와 같으면 거절한다.
function removeDemoDir() {
  const target = path.resolve(DEMO_DIR);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const real = [path.join(HOME, 'spaceLog'), process.env.SPACELOG_DATA].filter(Boolean).map((p) => path.resolve(p));
  if (path.basename(target) !== 'spaceLog-demo' || real.some((r) => same(r, target)) || same(target, path.resolve(HOME))) {
    fail(`지우지 않아요: ${target} 는 데모 폴더가 아니거나 실제 데이터 폴더예요.`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, HOST, () => s.close(() => resolve(true)));
  });
}

function run(args, label) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 실패 (code ${code})\n${out}`))));
  });
}

// ── 서버 ──
// 진짜 server/index.js 를 자식 프로세스로 띄운다. Windows 에서는 신호를 보낼 수 없으므로 IPC 로 'stop' 을 보내면
// 자식이 스스로 SIGINT 처리(파이썬 끄기 · DB 닫기)를 돈다. 부모가 죽어 IPC 가 끊겨도 같은 처리를 한다.
let server = null;

function startServer() {
  const entry = pathToFileURL(path.join(ROOT, 'server', 'index.js')).href;
  const boot = `
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; process.emit('SIGINT', 'SIGINT'); } };
    process.on('SIGINT', () => { stopping = true; });
    process.on('SIGTERM', () => { stopping = true; });
    process.on('message', (m) => { if (m === 'stop') stop(); });
    process.on('disconnect', stop);
    await import(${JSON.stringify(entry)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SPACELOG_RAG_PORT: String(RAG_PORT), SPACELOG_DATA: DEMO_DIR },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    const onLine = (line, isErr) => {
      if (/spaceLog\s+http:\/\//.test(line)) resolve();
      if (line.trim()) (isErr ? console.error : console.log)(`  │ ${line}`);
    };
    for (const [stream, isErr] of [[child.stdout, false], [child.stderr, true]]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        rest += chunk;
        let nl;
        while ((nl = rest.indexOf('\n')) >= 0) {
          onLine(rest.slice(0, nl).replace(/\r$/, ''), isErr);
          rest = rest.slice(nl + 1);
        }
        buf = rest;
      });
    }
    exited.then((code) => reject(new Error(`서버가 시작하지 못하고 끝났어요 (code ${code}) ${buf}`)));
    setTimeout(() => reject(new Error('서버가 30초 안에 뜨지 않았어요')), 30_000).unref();
  });
  server = {
    child,
    exited,
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.send('stop'); } catch { /* 이미 끊김 */ }
      const t = setTimeout(() => child.kill(), 15_000); // 그래도 안 끝나면 자기가 띄운 자식만 끈다
      await exited;
      clearTimeout(t);
    },
  };
  return server;
}

async function api(method, p, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, init); // Host 는 127.0.0.1:4848 로 나간다
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── 파일 만들기 ──
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// 세로 그라데이션 + 옅은 가로 줄무늬 PNG(RGB 8비트).
function makePng({ top, bottom, w, h }) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const r = y / (h - 1);
    const stripe = Math.floor(y / 12) % 2 ? 6 : 0;
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      for (let i = 0; i < 3; i++) {
        const v = Math.round(top[i] + (bottom[i] - top[i]) * r) - stripe + Math.round((x / w) * 10);
        raw[row + 1 + x * 3 + i] = Math.max(0, Math.min(255, v));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const MIME = { png: 'image/png', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', py: 'text/x-python' };

// ── 날짜 ──
function plannedDate(d, t, index) {
  const now = new Date();
  const [hh, mm] = t.split(':').map(Number);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, hh, mm, index % 50);
  if (at > now) {
    // 오늘인데 아직 안 된 시각: 지금보다 조금 전, 오늘 0시보다는 뒤
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return new Date(Math.max(start.getTime() + index * 1000, now.getTime() - (index + 1) * 7 * 60_000));
  }
  return at;
}

// ── 심기 ──
async function seedViaApi() {
  const planetId = { unsorted: 'unsorted' };
  for (const p of PLANETS) {
    const { key, ...body } = p;
    planetId[key] = (await api('POST', '/api/planets', body)).id;
  }
  const created = []; // { spec, star }
  for (const [i, s] of STARS.entries()) {
    const fields = { planet_id: planetId[s.p ?? 'unsorted'] };
    if (s.title) fields.title = s.title;
    if (s.body) fields.body = s.body;
    let res;
    if (s.files?.length) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      if (s.links?.length) form.append('links', JSON.stringify(s.links));
      for (const f of s.files) {
        const ext = f.name.split('.').pop().toLowerCase();
        const data = f.png ? makePng(f.png) : Buffer.from(f.text, 'utf8');
        form.append('files', new Blob([data], { type: MIME[ext] ?? 'application/octet-stream' }), f.name);
      }
      res = await api('POST', '/api/stars', form);
    } else {
      if (s.links?.length) fields.links = s.links;
      res = await api('POST', '/api/stars', fields);
    }
    if (res.skipped?.length) throw new Error(`별 ${i} 첨부를 건너뜀: ${JSON.stringify(res.skipped)}`);
    if (s.fav) await api('PATCH', `/api/stars/${res.star.id}`, { fav: true });
    created.push({ spec: s, star: res.star, index: i });
    process.stdout.write(`\r[demo] 별 ${i + 1}/${STARS.length}`);
  }
  process.stdout.write('\n');
  return { planetId, created };
}

function writeDb({ planetId, created }) {
  const db = new Database(path.join(DEMO_DIR, 'spacelog.db'));
  try {
    db.pragma('foreign_keys = ON');
    const setStar = db.prepare('UPDATE stars SET created_at = ? WHERE id = ?');
    const setAtt = db.prepare('UPDATE attachments SET created_at = ? WHERE star_id = ?');
    const setPlanet = db.prepare('UPDATE planets SET created_at = ? WHERE id = ?');
    const byKey = new Map();
    let earliest = Date.now();
    db.transaction(() => {
      for (const c of created) {
        const at = plannedDate(c.spec.d, c.spec.t, c.index);
        earliest = Math.min(earliest, at.getTime());
        setStar.run(at.toISOString(), c.star.id);
        setAtt.run(at.toISOString(), c.star.id);
        if (c.spec.key) byKey.set(c.spec.key, c.star);
      }
      const planetAt = new Date(earliest - 86_400_000).toISOString();
      for (const id of Object.values(planetId)) setPlanet.run(planetAt, id);
    })();

    const insConv = db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, unread) VALUES (?, ?, ?, ?, ?)');
    const insMsg = db.prepare(`INSERT INTO messages (id, conversation_id, role, content, sources, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, 'done', NULL, ?)`);
    const sourceOf = (ref) => {
      const key = typeof ref === 'string' ? ref : ref.key;
      const star = byKey.get(key);
      if (!star) throw new Error(`대화 출처 별이 없어요: ${key}`);
      const att = typeof ref === 'object' && ref.file ? star.attachments.find((a) => a.kind !== 'link') : null;
      return { star_id: star.id, attachment_id: att?.id ?? null, file_name: att?.file_name ?? null };
    };
    db.transaction(() => {
      for (const conv of CONVERSATIONS) {
        const id = crypto.randomUUID();
        let t = Date.now() - conv.ago * 3_600_000;
        const start = new Date(t).toISOString();
        const title = [...conv.messages[0].q.replace(/\s+/g, ' ')].slice(0, 30).join('').trim();
        const rows = [];
        for (const m of conv.messages) {
          rows.push([crypto.randomUUID(), id, 'user', m.q, '[]', new Date(t).toISOString()]);
          t += 9_000;
          rows.push([crypto.randomUUID(), id, 'assistant', m.a, JSON.stringify(m.sources.map(sourceOf)), new Date(t).toISOString()]);
          t += 4 * 60_000;
        }
        insConv.run(id, title, start, rows.at(-1)[5], conv.unread ? 1 : 0);
        for (const r of rows) insMsg.run(...r);
      }
    })();
  } finally {
    db.close();
  }
}

async function summary() {
  const [planets, stars, convs, settings] = await Promise.all([
    api('GET', '/api/planets'), api('GET', '/api/stars'), api('GET', '/api/chat/conversations'), api('GET', '/api/chat/settings'),
  ]);
  const fav = stars.filter((s) => s.fav).length;
  log(`행성 ${planets.length}개(미분류 포함) · 별 ${stars.length}개(☆ ${fav}) · 대화 ${convs.length}개 · 챗봇 ${settings.enabled ? '켜짐' : '꺼짐'}`);
}

async function main() {
  for (const p of [PORT, RAG_PORT]) {
    if (!(await portFree(p))) fail(`포트 ${p} 를 이미 쓰고 있어요. 데모가 이미 떠 있는지 확인하고, 그 프로그램을 닫은 뒤 다시 실행해 주세요.`);
  }
  if (reset || (fs.existsSync(DEMO_DIR) && !fs.existsSync(MARKER))) {
    if (fs.existsSync(DEMO_DIR)) log(reset ? `데모 폴더를 지워요: ${DEMO_DIR}` : '심다 만 데모 폴더라 지우고 다시 심어요');
    removeDemoDir();
  }

  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) fail('vite 가 없어요. 먼저 npm install 을 실행해 주세요.');
  log('웹을 빌드해요 (dist/)…');
  await run([vite, 'build'], 'vite build');

  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    log('끄는 중…');
    await server?.stop();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (!fs.existsSync(MARKER)) {
    log(`데모 데이터를 심어요: ${DEMO_DIR}`);
    startServer();
    try {
      await server.ready;
      const seeded = await seedViaApi();
      await server.stop();
      writeDb(seeded); // 날짜 되돌리기 · 대화 기록은 서버를 끈 채로
      startServer();
      await server.ready;
      // 날짜를 맞춘 뒤에 챗봇을 켜서 색인을 한 번만 만든다
      await api('PUT', '/api/chat/settings', { consented: true, enabled: true });
      fs.writeFileSync(MARKER, `${new Date().toISOString()}\n`);
    } catch (err) {
      console.error(err);
      await server?.stop();
      fail('심기에 실패했어요. npm run demo -- --reset 으로 다시 해 주세요.');
    }
  } else {
    startServer();
    try {
      await server.ready;
    } catch (err) {
      fail(err.message);
    }
  }

  server.exited.then((code) => {
    if (!stopping) fail(`서버가 끝났어요 (code ${code})`);
  });
  await summary().catch(() => {});
  console.log(`
  spaceLog 데모: ${BASE}
  로그인: 첫 화면의 '로그인'을 누르고 아무 이메일(예: demo@example.com) · 비밀번호 · 이름으로 들어가요.
          (주소가 달라 4747에서 한 로그인과 따로예요)
  데이터: ${DEMO_DIR}  (실제 ~/spaceLog 와 별개)
  챗봇: 저장소 .env 의 같은 OpenAI 키를 써요. 색인은 켠 뒤 잠시 걸려요.
  끄기: Ctrl+C   처음 상태로: npm run demo -- --reset
`);
}

main().catch(async (err) => {
  console.error(err);
  await server?.stop();
  process.exit(1);
});
