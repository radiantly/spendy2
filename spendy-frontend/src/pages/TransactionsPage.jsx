import { useState } from "react";

import Header from "../components/Header";
import SearchBar from "../components/SearchBar";
import TransactionList from "../components/TransactionList";
import mockData from "./mockData.json"; // Your mock transaction data
import "./TransactionsPage.css";

function TransactionsPage() {
  const [searchTerm, setSearchTerm] = useState("");

  const handleSearch = (event) => {
    setSearchTerm(event.target.value);
  };

  const totalSpending = mockData.reduce(
    (acc, transaction) => acc + transaction.amount,
    0
  );

  return (
    <div className="app">
      <Header totalSpending={totalSpending} />
      <SearchBar searchTerm={searchTerm} handleSearch={handleSearch} />
      <TransactionList searchTerm={searchTerm} transactions={mockData} />
    </div>
  );
}

export default TransactionsPage;
