export function normalizeSearchText(value) {
  return String(value ?? '').toLowerCase()
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function createSearchIndex(items, { titleOf = (item) => item?.name, fieldsOf = () => [], dynamicFieldsOf = null } = {}) {
  const rows = items.map((item, index) => {
    const fields = fieldsOf(item);
    const title = normalizeSearchText(titleOf(item));
    return {
      item,
      index,
      title,
      titleWords: title.split(' '),
      metadata: normalizeSearchText(Array.isArray(fields) ? fields.join(' ') : fields),
    };
  });

  return {
    size: rows.length,
    search(query) {
      const needle = normalizeSearchText(query);
      if (!needle) return [];
      const terms = needle.split(/\s+/);
      return rows.map((row) => {
        const dynamicFields = dynamicFieldsOf?.(row.item);
        const dynamicMetadata = dynamicFields == null ? '' : normalizeSearchText(Array.isArray(dynamicFields) ? dynamicFields.join(' ') : dynamicFields);
        const metadata = dynamicMetadata ? `${row.metadata} ${dynamicMetadata}` : row.metadata;
        if (!terms.every((term) => row.title.includes(term) || metadata.includes(term))) return null;

        let score = row.title === needle ? 1000 : row.title.startsWith(needle) ? 850 : row.title.includes(needle) ? 700 : 0;
        for (const term of terms) {
          if (row.title.includes(term)) score += row.titleWords.some((word) => word.startsWith(term)) ? 80 : 50;
          else score += 10;
        }
        return { item: row.item, score, index: row.index };
      }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ item, score }) => ({ item, score }));
    },
  };
}

export function searchCatalog(items, query, options) {
  return createSearchIndex(items, options).search(query);
}
