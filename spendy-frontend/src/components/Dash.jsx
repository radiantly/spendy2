import {
  dash,
  statbox,
  symbol,
  amount,
  timeframe,
} from "../css/Dash.module.css";

const Dash = ({ totalSpending }) => {
  const spend = totalSpending.toLocaleString("en", { useGrouping: true });
  return (
    <div className={dash}>
      <div className={statbox}>
        <span className={symbol}>₹</span>
        <span className={amount}>{spend}</span>
        <span className={timeframe}>spent in November 2023</span>
      </div>
    </div>
  );
};

export default Dash;
