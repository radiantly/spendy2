import React from "react";
import "./TransactionItem.css";
import { getCategoryColor } from "./categoryColors";

const TransactionItem = ({ transaction, visible }) => {
  const categoryColors = getCategoryColor(transaction.category);

  const categoryStyle = {
    backgroundColor: categoryColors.light,
    color: categoryColors.dark,
  };

  return (
    <div className={"transaction-item " + (visible ? "" : "hidden")}>
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
