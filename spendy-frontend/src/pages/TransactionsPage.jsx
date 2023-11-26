import { useMemo, useState } from "react";

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

  function parseTransactionData(data) {
    // Check if the data is an array
    if (!Array.isArray(data)) {
      return "Invalid data";
    }

    // Map each transaction to its parsed form
    return data.map(transaction => {
      let details;
      try {
        details = JSON.parse(transaction.details);
      } catch (e) {
        return "Error parsing transaction details for transaction ID " + transaction.id;
      }

      // Extract and return the relevant information
      return {
        id: transaction.id,
        date: transaction.date,
        type: details.type,
        amount: details.amount,
        party: details.party,
        currency: details.currency
      };
    });
  }

  const parsedtransactions = useMemo(() => parseTransactionData(transactions), [transactions])

  const totalSpending = parsedtransactions.reduce(
    (acc, transaction) => acc + transaction.amount,
    0
  );

  return (
    <div className={container}>
      <Navbar />
      <Dash totalSpending={totalSpending} />
      <SearchBar searchTerm={searchTerm} handleSearch={handleSearch} />
      <TransactionList searchTerm={searchTerm} transactions={parsedtransactions} />
    </div>
  );
}

export default TransactionsPage;
