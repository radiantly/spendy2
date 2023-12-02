import { useEffect, useState } from "react";

import SearchBar from "../components/SearchBar";
import TransactionList from "../components/TransactionList";
import { bgContainer, container } from "../css/TransactionsPage.module.css";
import { useLoaderData } from "react-router-dom";
import Navbar from "../components/Navbar";
import NewDash from "../components/NewDash";
import { useImmer } from "use-immer";
import TransactionGrid from "../components/TransactionGrid";

function TransactionsPage() {
  const loadedTransactions = useLoaderData();
  const [transactions, updateTransactions] = useImmer([]);
  useEffect(() => updateTransactions(loadedTransactions));

  console.log("Loader data:", transactions);
  const [searchTerm, setSearchTerm] = useState("");

  const handleSearch = (event) => {
    setSearchTerm(event.target.value);
  };

  const totalSpending = transactions.reduce(
    (acc, transaction) => acc + transaction.amount,
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
        <TransactionGrid transactions={transactions} />
      </div>
    </div>
  );
}

export default TransactionsPage;
