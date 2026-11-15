export function normalizeSearchText(value) {
  return String(value ?? '').toLowerCase()
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function searchCatalog(items, query, { titleOf = (item) => item?.name, fieldsOf = () => [] } = {}) {
  const needle = normalizeSearchText(query);
  if (!needle) return [];
  const terms = needle.split(/\s+/);

  return items.map((item, index) => {
    const title = normalizeSearchText(titleOf(item));
    const fields = fieldsOf(item);
    const metadata = normalizeSearchText(Array.isArray(fields) ? fields.join(' ') : fields);
    const matches = terms.every((term) => title.includes(term) || metadata.includes(term));
    if (!matches) return null;

    let score = title === needle ? 1000 : title.startsWith(needle) ? 850 : title.includes(needle) ? 700 : 0;
    for (const term of terms) {
      if (title.includes(term)) score += title.split(' ').some((word) => word.startsWith(term)) ? 80 : 50;
      else score += 10;
    }
    return { item, score, index, title };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score }) => ({ item, score }));
}
