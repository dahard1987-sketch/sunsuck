# CANB B5 Worksheet Studio

브라우저에서 B5 영문 해석지를 편집하고, 구조가 단순한 PDF를 직접 생성하는 정적 웹 앱입니다. 기존 PDF를 기기 안에서 새 객체 그래프로 재작성하는 최적화 도구도 포함합니다.

## PDF architecture

- `Download PDF`는 DOM 캡처나 브라우저 인쇄를 사용하지 않습니다. `pdf-lib`로 JIS B5 페이지에 텍스트, 선, 사각형을 직접 그립니다.
- 미리보기와 PDF의 영문은 Noto Sans Regular/Bold/Italic/Bold Italic을 사용하며, 한글은 Noto Sans KR을 사용합니다. 영문 글꼴은 문서에 쓰인 글자만 임베딩하고, `fontkit`의 CJK 부분집합이 일부 PDF 렌더러에서 글리프 맵을 손상시키는 문제를 피하기 위해 한국어 전용 글꼴은 안전하게 전체 임베딩합니다. 페이지 이미지가 없으므로 텍스트는 선택·검색할 수 있습니다.
- 각 페이지는 단일 콘텐츠 스트림을 사용하고, 그림자·마스크·투명 그룹·SVG·Form XObject를 만들지 않습니다.
- 업로드 최적화는 `pdf-lib`로 문서를 파싱하고 양식 외형을 고정한 뒤 모든 페이지를 새 `PDFDocument`로 복사합니다. 이 과정에서 페이지에서 도달할 수 없는 객체와 문서 수준의 JavaScript, 불필요한 메타데이터·부가 구조가 제외되고, 압축 객체 스트림으로 다시 저장됩니다.
- 주석은 시각적 의미를 바꿀 수 있으므로 일반 주석을 강제로 삭제하거나 래스터화하지 않습니다. 페이지 콘텐츠 자체의 수천 개 벡터 명령, 복잡한 투명도, 중첩 XObject를 브라우저에서 안전하게 해석·재작성할 수 없는 경우에는 그대로 보존됩니다.

## Run and test

추가 설치는 필요 없습니다. 라이브러리와 한글 폰트가 고정 버전으로 저장소에 포함되어 있습니다.

```sh
npm test
npm run serve
```

브라우저에서 `http://localhost:8000`을 열고 다음을 확인합니다.

1. 한 페이지 및 양면 지문에서 `Download PDF`를 실행합니다.
2. 한글/영문, 표식 서식, 선, 배경색, 긴 문장의 시각적 결과를 미리보기와 비교합니다.
3. PDF 뷰어에서 문장을 선택하고 검색합니다.
4. 브라우저 `인쇄 → PDF로 저장` 결과를 `Optimize Existing PDF`에 드롭합니다.
5. 처리 전후 파일 크기, 페이지, 객체, 폰트, 이미지, 콘텐츠 스트림 수를 진단 표에서 비교합니다.
6. 최종 파일을 Goodnotes에서 열고 스크롤, 확대, 필기, 페이지 전환을 점검합니다.

자동 테스트는 한 페이지, 여러 페이지, 한글+영문, 긴 텍스트, 선/배경색을 포함한 직접 생성 PDF와 양식·미사용 객체가 많은 기존 PDF 재작성을 검증합니다.

## Vendored dependencies

- `pdf-lib` 1.17.1 — MIT
- `@pdf-lib/fontkit` 1.1.1 — MIT
- Noto Sans — SIL Open Font License 1.1 (`assets/OFL-NotoSans.txt`)
- Noto Sans KR — SIL Open Font License 1.1 (`assets/OFL-NotoSansCJK.txt`)
