import { useEffect, useState } from "react";

import TransactionList from "../components/TransactionList";
import { bgContainer, container } from "../css/TransactionsPage.module.css";
import { useLoaderData } from "react-router-dom";
import Navbar from "../components/Navbar";
import NewDash from "../components/NewDash";
import { useImmer } from "use-immer";
import TransactionGrid from "../components/TransactionGrid";
import { toINR } from "../currency";

function TransactionsPage() {
  const loadedTransactions = useLoaderData();
  const [transactions, updateTransactions] = useImmer([]);
  useEffect(() => updateTransactions(loadedTransactions), [loadedTransactions]);

  console.log("Loader data:", transactions);

  const totalSpending = transactions.reduce(
    (acc, transaction) =>
      acc +
      (transaction.hidden
        ? 0
        : toINR(transaction.currency, transaction.amount)),
    0
  );

  return (
    <div className={bgContainer}>
      <div className={container}>
        {/* <Navbar /> */}
        <NewDash totalSpending={totalSpending} />
        {/* <Dash totalSpending={totalSpending} /> */}
        {/* <SearchBar searchTerm={searchTerm} handleSearch={handleSearch} /> */}
        {/* <TransactionList searchTerm={searchTerm} transactions={transactions} /> */}
        <TransactionGrid
          transactions={transactions}
          updateTransactions={updateTransactions}
        />
      </div>
    </div>
  );
}

export default TransactionsPage;
