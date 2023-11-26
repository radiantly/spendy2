import {
  dash,
  statbox,
  symbol,
  amount,
  number,
  spentin,
  timeframe,
} from "../css/Dash.module.css";

const Dash = ({ totalSpending }) => {
  const spend = totalSpending.toLocaleString("en", { useGrouping: true });
  return (
    <div className={dash}>
      <div className={statbox}>
        <div className={amount}>
          <span className={symbol}>₹</span>
          <span className={number}>{spend}</span>
        </div>
        <div className={timeframe}>
          <span className={spentin}>spent in </span>November 2023
        </div>
      </div>
    </div>
  );
};

export default Dash;
