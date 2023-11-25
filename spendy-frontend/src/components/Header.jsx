import React from "react";
import "./Header.css";

const Header = ({ totalSpending }) => {
  return (
    <header className="header">
      <h1>Spendy</h1>
      <div className="total-spending">
        ₹{totalSpending} spent in November 2023
      </div>
    </header>
  );
};

export default Header;
