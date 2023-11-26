import "./Header.css";
import Logo from "./Logo";

const Header = ({ totalSpending }) => {
  return (
    <header className="header">
      <Logo />
      <div className="total-spending">
        ₹{totalSpending} spent in November 2023
      </div>
    </header>
  );
};

export default Header;
