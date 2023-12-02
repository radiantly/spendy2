import { container, amount, timeframe } from "../css/NewDash.module.css";

const NewDash = ({ totalSpending }) => {
  const spend = totalSpending.toLocaleString("en", { useGrouping: true });
  return (
    <div className={container}>
      <div className={amount}>Rs {totalSpending}</div>
      <div className={timeframe}>spent last month</div>
    </div>
  );
};

export default NewDash;
