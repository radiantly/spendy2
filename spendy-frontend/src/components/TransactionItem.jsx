import React from "react";
import "./TransactionItem.css";
import { getCategoryColor } from "./categoryColors";

const TransactionItem = ({ transaction }) => {
  const categoryColors = getCategoryColor(transaction.category);

  const categoryStyle = {
    backgroundColor: categoryColors.light,
    color: categoryColors.dark,
    borderRadius: "15px",
    padding: "3px 10px",
    display: "inline-block",
    margin: "0 5px",
  };

  return (
    <div className="transaction-item">
      <div className="date">{transaction.date}</div>
      <div className="description">
        {transaction.description}
        <span className="category-pill" style={categoryStyle}>
          {transaction.category}
        </span>
      </div>
      <div className="amount">₹{transaction.amount}</div>
      <div className="mode-of-payment">{transaction.modeOfPayment}</div>
      <div className="sender-receiver">{transaction.senderReceiver}</div>
    </div>
  );
};

export default TransactionItem;
