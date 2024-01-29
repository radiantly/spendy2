self.transactions = {};

const performSearch = (searchInput) => {
  const matches = [];
  try {
    const re = new RegExp(searchInput, "im");

    for (const [id, transaction] of Object.entries(self.transactions))
      if (
        re.test(transaction.party) ||
        re.test(transaction.remarks) ||
        re.test(transaction.type) ||
        re.test(transaction.amount) ||
        re.test(transaction.currency)
      )
        matches.push(id);
  } catch {
    for (const [id, transaction] of Object.entries(self.transactions))
      if (
        transaction.party.includes(searchInput) ||
        transaction.remarks.includes(searchInput) ||
        transaction.type.includes(searchInput) ||
        transaction.amount.toString().includes(searchInput) ||
        transaction.currency.includes(searchInput)
      )
        matches.push(id);
  }
  return matches;
};

addEventListener("message", (event) => {
  const { transactions, searchInput } = event.data;
  if (transactions) self.transactions = transactions;

  if (searchInput) {
    const matches = performSearch(searchInput);
    postMessage({ filterList: matches, searchInput });
    return;
  }
});
