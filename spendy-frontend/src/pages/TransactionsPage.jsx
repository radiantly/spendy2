import { useState } from "react";

import SearchBar from "../components/SearchBar";
import TransactionList from "../components/TransactionList";
import mockData from "./mockData.json"; // Your mock transaction data
import { container } from "../css/TransactionsPage.module.css";
import { useLoaderData } from "react-router-dom";
import Navbar from "../components/Navbar";
import Dash from "../components/Dash";

function TransactionsPage() {
  const transactions = useLoaderData();
  console.log("Loader data:", transactions);
  const [searchTerm, setSearchTerm] = useState("");

  const handleSearch = (event) => {
    setSearchTerm(event.target.value);
  };

  const totalSpending = mockData.reduce(
    (acc, transaction) => acc + transaction.amount,
    0
  );

  return (
    <div className={container}>
      <Navbar />
      <Dash totalSpending={totalSpending} />
      <SearchBar searchTerm={searchTerm} handleSearch={handleSearch} />
      <TransactionList searchTerm={searchTerm} transactions={mockData} />
    </div>
  );
}

export default TransactionsPage;
