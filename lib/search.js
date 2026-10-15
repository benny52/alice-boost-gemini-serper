import { clipText } from './session.js';
import { fetchJson } from './http.js';

const EXPLICIT_SEARCH = /найди|поищи|поищем|проверь.{0,25}(информац|интернет)|\b(search|look up)\b/i;
const CREATIVE = /придумай|сочини|(?:расскажи|напиши).{0,30}(?:сказк|стих)|\b(?:invent|write a story)\b/i;
const CALCULATION = /^(?:(?:сколько будет|вычисли|посчитай|calculate|what is)\s+)?-?\d+(?:[.,]\d+)?(?:\s*(?:[+*/×÷−-]|плюс|минус|умножить(?:\s+на)?|разделить(?:\s+на)?|делить(?:\s+на)?)\s*-?\d+(?:[.,]\d+)?)+[?!.]*$/i;
const FRESH = /\b(latest|today|current|news|weather|price|exchange rate|recent)\b|сегодня|сейчас|завтра|вчера|последн|новост|погод|прогноз|курс валют|актуальн|сколько стоит|свежие данные|\b(?:19|20)\d{2}\b|(?:кто|какой|как зовут).{0,45}(?:президент|премьер|мэр|министр|руководит|тренер)/i;
const PRONOUN = /(?:^|[^\p{L}])(?:он|она|они|оно|его|её|ее|их|него|неё|нее|этом|этот|это|там|тогда)(?:$|[^\p{L}])/iu;
const RELATIVE_DATE = /сегодня|завтра|послезавтра|вчера|позавчера/gi;
const tidy = text => text.replace(/[?!]+/g, '').replace(/\s+/g, ' ').trim();

export function isSearchIntent(text) {
  if (EXPLICIT_SEARCH.test(text)) return true;
  return !CREATIVE.test(text) && !CALCULATION.test(text.trim()) && FRESH.test(text);
}

function isFollowup(text) {
  if (CREATIVE.test(text)) return false;
  const short = text.trim().replace(/^(?:а|и)\s+/i, '');
  return PRONOUN.test(short)
    || /^(?:на\s+)?(?:сегодня|завтра|послезавтра|вчера|позавчера)(?:\s+(?:в|во|для)\s+[\p{L}\s-]{2,60})?[?!.,\s]*$/iu.test(short)
    || /^(?:в|во|для)\s+[\p{L}\s-]{2,60}[?!.,\s]*$/u.test(short)
    || /^(?:подробнее|продолжи|повтори|ещё|еще|попробуй ещё раз|попробуй еще раз)[?!.,\s]*$/i.test(short)
    || /^(?:найди|поищи)\s+(?:прогноз\s+)?на\s+(?:завтра|сегодня|неделю)/i.test(short);
}

export function planSearch(text, state) {
  const previousQuestion = state.history.filter(item => item.role === 'user').at(-1)?.text || '';
  const previousTopic = state.search?.query || previousQuestion;
  const followup = isFollowup(text);
  const required = isSearchIntent(text) || (followup && Boolean(state.search?.query || isSearchIntent(previousQuestion)));
  if (!required) return { required: false };
  if (!followup || !previousTopic) return { required: true, query: clipText(text, 500), topic: text };

  const continuation = tidy(text.replace(/^(?:а|и)\s+/i, ''));
  let query;
  if (/погод|прогноз|\bweather\b/i.test(previousTopic)) {
    const location = continuation.match(/(?:^|\s)((?:в|во|для)\s+[\p{L}\s-]+)$/iu);
    if (location) {
      const date = continuation.match(RELATIVE_DATE)?.at(-1) || previousTopic.match(RELATIVE_DATE)?.at(-1) || '';
      const city = location[1].replace(RELATIVE_DATE, '');
      query = tidy(`Погода ${date} ${city}`);
    } else {
      const base = continuation.match(RELATIVE_DATE) ? previousTopic.replace(RELATIVE_DATE, '') : previousTopic;
      query = tidy(`${base} ${continuation}`);
    }
    return { required: true, query: clipText(query, 500), topic: query };
  }

  const previousAnswer = state.history.filter(item => item.role === 'model').at(-1)?.text || '';
  query = tidy(`${clipText(previousTopic, 160)} ${PRONOUN.test(text) ? clipText(previousAnswer, 160) : ''} ${clipText(continuation, 160)}`);
  // Keep a stable topic rather than recursively storing each expanded query.
  return { required: true, query: clipText(query, 500), topic: previousTopic };
}

export async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { status: 'unavailable' };
  if (timeoutMs < 150) return { status: 'timeout' };
  try {
    const { response, data } = await fetchJson('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 3 })
    }, timeoutMs);
    if (!response.ok) return { status: 'error' };
    const items = (Array.isArray(data?.organic) ? data.organic : [])
      .filter(item => item && typeof item.snippet === 'string' && item.snippet.trim())
      .slice(0, 3)
      .map(item => ({ title: clipText(item.title, 180), snippet: clipText(item.snippet, 350), link: clipText(item.link, 240) }));
    const answerBox = data?.answerBox?.answer || data?.answerBox?.snippet;
    if (typeof answerBox === 'string' && answerBox.trim()) items.unshift({ snippet: clipText(answerBox, 350) });
    return items.length ? { status: 'ok', context: JSON.stringify(items) } : { status: 'empty' };
  } catch (error) {
    return { status: error?.message === 'REQUEST_TIMEOUT' || error?.message === 'TIME_BUDGET_EXHAUSTED' ? 'timeout' : 'error' };
  }
}

export function searchFailureText(status) {
  switch (status) {
    case 'unavailable': return 'Поиск пока не подключён, поэтому я не могу проверить актуальные сведения.';
    case 'empty': return 'Не удалось найти подходящие источники. Уточни вопрос для поиска.';
    case 'timeout': return 'Не успела проверить информацию в поиске. Попробуй ещё раз чуть позже.';
    default: return 'Сейчас поиск недоступен. Не удалось проверить информацию; попробуй позже.';
  }
}
