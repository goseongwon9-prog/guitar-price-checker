/**
 * Cloudflare Worker — 한국 악기 쇼핑몰 가격 검색
 *
 * 6개 사이트(Cafe24 3개, Godo 2개, Custom 1개)의 검색 결과를 병렬 fetch + 파싱.
 *
 * 사용:
 *   GET /?query=검색어                   → 모든 사이트 병렬 검색
 *   GET /?query=X&site=musicforce        → 특정 사이트만
 *   GET /?query=X&site=musicforce,buzzbee → 여러 사이트
 *   GET /?query=X&site=musicforce&debug=html → HTML 일부 반환 (파서 디버깅용)
 */

const SITES = {
  musicforce: {
    name: '뮤직포스',
    baseUrl: 'https://musicforce.co.kr',
    searchUrl: (q) => `https://musicforce.co.kr/product/search.html?banner_action=&keyword=${encodeURIComponent(q)}`,
    parser: 'cafe24'
  },
  guitarnet: {
    name: '기타네트',
    baseUrl: 'https://guitarnet.co.kr',
    searchUrl: (q) => `https://guitarnet.co.kr/product/search.html?banner_action=&keyword=${encodeURIComponent(q)}`,
    parser: 'cafe24'
  },
  instation: {
    name: '인스테이션',
    baseUrl: 'https://instation.co.kr',
    searchUrl: (q) => `https://instation.co.kr/product/search.html?banner_action=&keyword=${encodeURIComponent(q)}`,
    parser: 'cafe24'
  },
  buzzbee: {
    name: '버즈비',
    baseUrl: 'https://www.buzzbee.co.kr',
    searchUrl: (q) => `https://www.buzzbee.co.kr/goods/goods_search.php?keyword=${encodeURIComponent(q)}&recentCount=10`,
    parser: 'godo'
  },
  freebud: {
    name: '프리버드',
    baseUrl: 'https://freebud.co.kr',
    searchUrl: (q) => `https://freebud.co.kr/goods/goods_search.php?keyword=${encodeURIComponent(q)}&recentCount=10`,
    parser: 'godo'
  },
  schoolmusic: {
    name: '스쿨뮤직',
    baseUrl: 'https://www.schoolmusic.co.kr',
    searchUrl: (q) => `https://www.schoolmusic.co.kr/Shop/index.php3?var=Search&max_cnt=15&keyword=${encodeURIComponent(q)}`,
    parser: 'schoolmusic',
    encoding: 'euc-kr'  // 옛날 PHP3 사이트, EUC-KR 인코딩
  }
};

const PARSERS = {
  cafe24: parseCafe24,
  godo: parseGodo,
  schoolmusic: parseSchoolmusic
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);

    // 실시간 환율 엔드포인트 — Yahoo Finance → Naver Finance fallback
    if (url.pathname === '/rates') {
      return await handleRates();
    }

    // 환율 히스토리 (Yahoo Finance chart API)
    if (url.pathname === '/rates/history') {
      return await handleRatesHistory(url);
    }

    const query = url.searchParams.get('query');
    const siteFilter = url.searchParams.get('site');
    const debug = url.searchParams.get('debug');

    if (!query) return json({ error: 'query 파라미터 필요' }, 400);

    const siteIds = siteFilter
      ? siteFilter.split(',').filter(id => SITES[id])
      : Object.keys(SITES);

    if (siteIds.length === 0) {
      return json({ error: `알 수 없는 사이트. 가능한 값: ${Object.keys(SITES).join(', ')}` }, 400);
    }

    const offset = parseInt(url.searchParams.get('offset') || '0');
    const results = await Promise.all(siteIds.map(id => fetchSite(id, query, debug, offset)));

    // 모든 사이트에서 받은 아이템 합치고 가격순 정렬
    const allItems = results
      .filter(r => r.items)
      .flatMap(r => r.items.map(i => ({ ...i, mallName: r.site })));
    allItems.sort((a, b) => a.lprice - b.lprice);

    // 디버그 모드는 캐시 없이 — 매번 fresh data로 반복 테스트 가능
    const respond = debug ? jsonNoCache : json;
    return respond({
      query,
      siteResults: results,           // 사이트별 결과 (디버깅용)
      items: allItems.slice(0, 15)    // 통합 가격순 상위 15개
    });
  }
};

async function fetchSite(siteId, query, debug, offset = 0) {
  const site = SITES[siteId];
  try {
    const targetUrl = site.searchUrl(query);
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Referer': site.baseUrl + '/'
      }
    });

    if (!res.ok) {
      return { site: site.name, siteId, error: `HTTP ${res.status}`, url: targetUrl };
    }

    // 사이트별 인코딩 처리 (스쿨뮤직 등 옛날 사이트는 EUC-KR)
    const encoding = site.encoding || 'utf-8';
    let html;
    if (encoding === 'utf-8') {
      html = await res.text();
    } else {
      const buffer = await res.arrayBuffer();
      try {
        html = new TextDecoder(encoding).decode(buffer);
      } catch (e) {
        // TextDecoder가 해당 encoding 지원 안 하면 fallback
        html = new TextDecoder('utf-8').decode(buffer);
      }
    }

    if (debug === 'html') {
      // offset 지정 시 그 위치부터 8KB 반환 (수동 탐색용)
      if (offset > 0) {
        return {
          site: site.name,
          siteId,
          htmlLength: html.length,
          debugMode: `manual offset=${offset}`,
          htmlSample: html.slice(offset, offset + 8000)
        };
      }
      // 기본: marker 찾아서 상품 영역 반환 (+ 어떤 marker 매칭됐는지)
      const result = findRelevantSection(html);
      return {
        site: site.name,
        siteId,
        htmlLength: html.length,
        debugMode: `marker=${result.match}, position=${result.position}`,
        htmlSample: result.section
      };
    }

    if (debug === 'head') {
      return {
        site: site.name,
        siteId,
        htmlLength: html.length,
        htmlSample: html.slice(0, 8000)
      };
    }

    const items = PARSERS[site.parser](html, site.baseUrl);

    // 파싱 결과가 0개면 디버그용 정보도 같이 반환
    if (items.length === 0) {
      return {
        site: site.name,
        siteId,
        items: [],
        warning: '파싱 결과 0건. 검색결과 진짜 없거나 파서 수정 필요',
        diagnostics: {
          htmlLength: html.length,
          anchorBoxNameCount: (html.match(/anchorBoxName_/g) || []).length,
          xansRecordCount: (html.match(/xans-record-/g) || []).length,
          goodsViewCount: (html.match(/goods_view\.php/g) || []).length,
          priceWonCount: (html.match(/\d{1,3}(?:,\d{3})+\s*원/g) || []).length
        },
        htmlSample: findRelevantSection(html)
      };
    }

    return { site: site.name, siteId, items: items.slice(0, 5), count: items.length };
  } catch (e) {
    return { site: site.name, siteId, error: e.message };
  }
}

// ─── 파서 ────────────────────────────────

// Cafe24 (뮤직포스, 기타네트, 인스테이션)
// 전략: /product/...로 가는 anchor 전부 매칭. URL 형식 두 가지 지원:
//   - 쿼리: /product/detail.html?product_no=NNNN  (musicforce)
//   - SEO:  /product/{slug}/NNNN/category/...    (guitarnet, instation)
// 한 상품당 anchor가 여러 개일 수 있고 (이미지 캐러셀의 "이전/다음" 버튼 텍스트 포함),
// 같은 productId에 대해 **가장 긴 텍스트**를 가진 anchor를 진짜 상품명으로 채택.
function parseCafe24(html, baseUrl) {
  const candidates = new Map();  // productId -> { title, link, anchorEnd }
  const linkRegex = /<a[^>]+href="([^"]*\/product\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1];
    const inner = m[2];

    // Product ID 추출 — 쿼리 파라미터 형식 우선, 없으면 SEO 경로 형식
    let productId;
    const queryMatch = href.match(/product_no=(\d+)/);
    const seoMatch = href.match(/\/product\/[^/]+\/(\d+)(?:[/?]|$)/);
    if (queryMatch) productId = queryMatch[1];
    else if (seoMatch) productId = seoMatch[1];
    else continue;

    // 1) displaynone 클래스 element 제거 시도 (back-reference로 같은 태그 닫힘 매칭)
    // 2) 나머지 태그 제거 → 순수 텍스트
    // 3) 남은 "상품명 :" 같은 라벨 prefix 제거
    const title = inner
      .replace(/<(\w+)[^>]+class="[^"]*displaynone[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      // 라벨(상품명 등) + ":" 또는 ":" 단독으로 시작하면 제거
      .replace(/^(?:(?:상품명|상품요약정보|판매가|적립금)\s*)?[:|·]\s*/, '')
      .trim();

    if (!title || title.length < 5) continue;

    // 같은 productId에 대해 더 긴 title이 나오면 교체 (이미지 anchor의 "이전 다음" < 실제 상품명)
    const existing = candidates.get(productId);
    if (!existing || title.length > existing.title.length) {
      candidates.set(productId, {
        title,
        link: href.startsWith('http') ? href : baseUrl + (href.startsWith('/') ? '' : '/') + href,
        anchorEnd: m.index + m[0].length
      });
    }
  }

  // 각 productId마다 가격 찾기 (채택된 anchor 직후 윈도우에서)
  const items = [];
  for (const [, c] of candidates) {
    const after = html.slice(c.anchorEnd, c.anchorEnd + 2000);
    const priceMatch = after.match(/판매가[\s\S]{0,300}?(\d{1,3}(?:,\d{3})+)/) ||
                       after.match(/(\d{1,3}(?:,\d{3})+)\s*원/);
    if (priceMatch) {
      items.push({
        title: c.title,
        lprice: parseInt(priceMatch[1].replace(/,/g, '')),
        link: c.link
      });
    }
  }
  return items;
}

// Godo (버즈비, 프리버드)
// 전략: HTML 파싱 대신 wishlist 버튼의 data-* 속성에서 구조화된 데이터 추출.
// Godo 플랫폼 표준 wishlist 버튼은 다음을 모두 포함:
//   data-goods-no="3361" data-goods-nm="상품명" data-goods-price="27000.00"
// productId로 dedupe.
function parseGodo(html, baseUrl) {
  const items = [];
  const seen = new Set();
  // data-goods-no가 있는 button 태그 전부 찾기
  const buttonRegex = /<button[^>]+data-goods-no="(\d+)"[^>]*>/g;

  let m;
  while ((m = buttonRegex.exec(html)) !== null) {
    const buttonTag = m[0];
    const productId = m[1];

    if (seen.has(productId)) continue;

    // 같은 button 태그 안에서 nm + price 속성 추출
    const nmMatch = buttonTag.match(/data-goods-nm="([^"]+)"/);
    const priceMatch = buttonTag.match(/data-goods-price="([\d.]+)"/);
    if (!nmMatch || !priceMatch) continue;  // cart 버튼 등 일부 속성 없는 경우 스킵

    const title = decodeHtmlEntities(nmMatch[1]);
    const price = Math.floor(parseFloat(priceMatch[1]));
    if (!title || title.length < 3 || price <= 0) continue;

    seen.add(productId);
    items.push({
      title,
      lprice: price,
      link: `${baseUrl}/goods/goods_view.php?goodsNo=${productId}`
    });
  }
  return items;
}

// HTML entity 디코딩 (data-* 속성 값에 종종 들어있음)
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Schoolmusic (custom PHP3, EUC-KR, table-based 레이아웃)
// 전략:
//   1) 상품 상세 링크 `href="...var=Good&Good_no=NNNNN..."` 매칭 (productId 추출)
//   2) 링크 위치 직후 ~3KB 윈도우 추출
//   3) <strike>...</strike> 제거 (원가 라인 삭제)
//   4) 첫 N,NNN원을 판매가로 채택
//   5) 모든 <font>...</font> 중에서 '원' 미포함 + 5~200자 + 숫자만 아닌 것을 제목으로 채택
function parseSchoolmusic(html, baseUrl) {
  const items = [];
  const seen = new Set();
  const linkRegex = /href="[^"]*var=Good(?:&|&amp;)Good_no=(\d+)[^"]*"/g;

  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const productId = m[1];
    if (seen.has(productId)) continue;

    // 링크 위치부터 ~3KB 윈도우 (한 상품 셀에 들어맞는 범위)
    const after = html.slice(m.index, m.index + 3000);

    // 원가(strikethrough) 제거 → 판매가만 남음
    const cleaned = after.replace(/<strike[^>]*>[\s\S]*?<\/strike>/gi, '');

    // 판매가: strike 제거 후 첫 N,NNN원
    const priceMatch = cleaned.match(/(\d{1,3}(?:,\d{3})+)\s*원/);
    if (!priceMatch) continue;

    // 제목: 모든 <font> 내용 중 "원" 미포함 + 적당한 길이 + 순수 숫자/라벨 아닌 것
    let title = '';
    const fontMatches = cleaned.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/gi);
    for (const fm of fontMatches) {
      const text = fm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.length >= 5 && text.length <= 200 &&
          !/원/.test(text) &&
          !/^\d+$/.test(text) &&
          !text.startsWith('상품번호') &&
          !text.startsWith('%')) {
        title = text;
        break;
      }
    }

    if (!title) continue;

    seen.add(productId);
    items.push({
      title,
      lprice: parseInt(priceMatch[1].replace(/,/g, '')),
      link: `${baseUrl}/Shop/index.php3?var=Good&Good_no=${productId}&version=pc`
    });
  }
  return items;
}

// ─── 실시간 환율 ────────────────────────────────
// Yahoo Finance JSON API (1차) → Naver Finance HTML (2차)
async function handleRates() {
  // Yahoo Finance 시도
  try {
    const [jpyKrw, usdKrw] = await Promise.all([
      fetchYahooRate('JPYKRW'),
      fetchYahooRate('USDKRW')
    ]);
    return jsonNoCache({
      jpyKrw,
      usdKrw,
      updated: new Date().toISOString(),
      source: 'yahoo-finance'
    });
  } catch (e) {
    console.warn('[Rates] Yahoo 실패:', e.message);
  }

  // Naver Finance 시도
  try {
    const [jpyKrw, usdKrw] = await Promise.all([
      fetchNaverRate('FX_JPYKRW'),
      fetchNaverRate('FX_USDKRW')
    ]);
    return jsonNoCache({
      jpyKrw,
      usdKrw,
      updated: new Date().toISOString(),
      source: 'naver-finance'
    });
  } catch (e) {
    console.warn('[Rates] Naver 실패:', e.message);
    return jsonNoCache({ error: '모든 환율 소스 실패: ' + e.message }, 502);
  }
}

// 환율 히스토리: Yahoo Finance chart API에서 시계열 데이터 가져옴
// 각 period별 raw 데이터를 fetch → sliceLast로 기간 cut → downsample로 균등 N개 추출
//   3h:  9포인트 × 20분 간격  (raw: 5m × last 36)
//   12h: 12포인트 × 1시간 간격 (raw: 1h × last 12)
//   1d:  12포인트 × 2시간 간격 (raw: 1h × last 24)
//   1w:  14포인트 × 12시간 간격 (raw: 1h × last 168)
//   1mo: 15포인트 × 2일 간격   (raw: 1h × last 720)
async function handleRatesHistory(url) {
  const pair = (url.searchParams.get('pair') || 'JPYKRW').toUpperCase();
  const period = url.searchParams.get('period') || '1d';

  const config = {
    '3h':  { interval: '5m', range: '1d',  sliceLast: 36,  points: 9 },
    '12h': { interval: '1h', range: '1d',  sliceLast: 12,  points: 12 },
    '1d':  { interval: '1h', range: '1d',  sliceLast: 24,  points: 12 },
    '1w':  { interval: '1h', range: '1mo', sliceLast: 168, points: 14 },
    '1mo': { interval: '1h', range: '1mo', sliceLast: 720, points: 15 }
  }[period];

  if (!config) return jsonNoCache({ error: `invalid period: ${period}` }, 400);
  if (!['JPYKRW', 'USDKRW'].includes(pair)) {
    return jsonNoCache({ error: `invalid pair: ${pair}` }, 400);
  }

  try {
    const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X?interval=${config.interval}&range=${config.range}`;
    const res = await fetch(yUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const yData = await res.json();
    const result = yData?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    if (timestamps.length === 0) throw new Error('Yahoo: 데이터 없음');

    // 1) null 제거
    let data = timestamps
      .map((t, i) => ({ t: t * 1000, rate: closes[i] }))
      .filter(d => d.rate != null && isFinite(d.rate));

    // 2) 최근 N개만 (period 길이만큼)
    if (config.sliceLast) data = data.slice(-config.sliceLast);

    // 3) 균등 간격으로 N개 추출 (요청된 포인트 수만큼)
    if (config.points && data.length > config.points) {
      const step = (data.length - 1) / (config.points - 1);
      const sampled = [];
      for (let i = 0; i < config.points; i++) {
        sampled.push(data[Math.round(i * step)]);
      }
      data = sampled;
    }

    return new Response(JSON.stringify({
      pair, period,
      source: 'yahoo-finance',
      data
    }), {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        // 환율 히스토리는 5분 캐시 (분단위까지 정밀할 필요 없음)
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch (e) {
    return jsonNoCache({ error: 'Yahoo history 실패: ' + e.message }, 502);
  }
}

async function fetchYahooRate(pair) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!res.ok) throw new Error(`Yahoo ${pair} HTTP ${res.status}`);
  const data = await res.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) {
    throw new Error(`Yahoo ${pair}: 가격 필드 없음`);
  }
  return price;
}

async function fetchNaverRate(code) {
  // code: 'FX_JPYKRW' 또는 'FX_USDKRW'
  const url = `https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=${code}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://finance.naver.com/'
    }
  });
  if (!res.ok) throw new Error(`Naver ${code} HTTP ${res.status}`);

  const buffer = await res.arrayBuffer();
  let html;
  try {
    html = new TextDecoder('euc-kr').decode(buffer);
  } catch {
    html = new TextDecoder('utf-8').decode(buffer);
  }

  // "매매기준율" 근처의 숫자 추출 (Naver Finance 표준 라벨)
  const m = html.match(/매매기준율[\s\S]{0,500}?(\d{1,3}(?:,\d{3})*\.\d{1,4})/);
  if (!m) throw new Error(`Naver ${code}: 매매기준율 못 찾음`);
  const rate = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(rate) || rate <= 0) throw new Error(`Naver ${code}: 파싱 실패`);

  // JPY는 보통 "100엔당" 기준으로 표시되니 1엔 환산은 /100
  if (code === 'FX_JPYKRW') return rate / 100;
  return rate;
}

// ─── 유틸 ────────────────────────────────

// 파싱 실패 시 디버그용 — 상품 영역으로 추정되는 부분 + 어떤 marker 매칭됐는지
function findRelevantSection(html) {
  // marker 이름 + 정규식 쌍 (Godo 패턴 다수 추가)
  const markers = [
    ['anchorBoxName_', /anchorBoxName_/],
    ['goods_view', /goods_view/],                    // .php 유무 무관
    ['goodsNo=', /goodsNo=/],                         // Godo URL 파라미터
    ['gd-goods-list', /gd-goods-list|gd_goods_list/],
    ['prdList', /prdList|xans-record-product-listmain/],
    ['goods_list_item', /goods_list_item|item_cont|goodsDisplayItem|item_list|item_box/],
    ['data-goods', /data-goods-?no|data-goodsno/i],
    ['price_won', /\d{1,3}(?:,\d{3})+\s*원/]
  ];
  for (const [name, re] of markers) {
    const idx = html.search(re);
    if (idx > 0) {
      return {
        match: name,
        position: idx,
        section: html.slice(Math.max(0, idx - 500), idx + 7500)
      };
    }
  }
  return { match: 'none-fallback-head', position: 0, section: html.slice(0, 5000) };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// 디버그 응답은 캐시 없이 — 매번 fresh data
function jsonNoCache(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300'
  };
}
