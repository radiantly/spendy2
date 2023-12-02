import React from "react";
import "./TransactionItem.css";
import { getCategoryColor } from "./categoryColors";

const TransactionItem = ({ transaction, visible }) => {
  const categoryColors = getCategoryColor("None");

  const categoryStyle = {
    backgroundColor: categoryColors.light,
    color: categoryColors.dark,
  };

  return (
    <div className={"transaction-item " + (visible ? "" : "hidden")}>
      <div className="date">{transaction.date.toDateString()}</div>
      <div className="description">
        {transaction.party}
        <span className="category-pill" style={categoryStyle}>
          {"None"}
        </span>
      </div>
      <div className="amount">₹{transaction.amount}</div>
      <div className="mode-of-payment">{transaction.type}</div>
    </div>
  );
};

export default TransactionItem;
