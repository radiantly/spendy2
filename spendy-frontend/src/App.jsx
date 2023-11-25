import React, { useState } from "react";

import Header from "./Header";
import SearchBar from "./SearchBar";
import TransactionList from "./TransactionList";
import mockData from "./mockData.json"; // Your mock transaction data
import "./App.css";

function App() {
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

export default App;
