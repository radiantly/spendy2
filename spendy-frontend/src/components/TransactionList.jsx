import React from "react";
import TransactionItem from "./TransactionItem";
import "./TransactionList.css";

const TransactionList = ({ searchTerm, transactions }) => {
  const filteredTransactions = transactions.filter((transaction) =>
    transaction.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="transaction-list">
      {filteredTransactions.map((transaction) => (
        <TransactionItem key={transaction.id} transaction={transaction} />
      ))}
    </div>
  );
};

export default TransactionList;
