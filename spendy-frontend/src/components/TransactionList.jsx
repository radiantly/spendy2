import React from "react";
import TransactionItem from "./TransactionItem";
import "./TransactionList.css";
import Fuse from "fuse.js";

const TransactionList = ({ searchTerm, transactions }) => {
  return (
    <div className="transaction-list">
      {transactions.map((transaction) => (
        <TransactionItem
          key={transaction.id}
          transaction={transaction}
          visible={transaction.description
            .toLowerCase()
            .includes(searchTerm.toLowerCase())}
        />
      ))}
    </div>
  );
};

export default TransactionList;
