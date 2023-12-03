import { container, amount, timeframe } from "../css/Dash.module.css";
import AnimatedNumber from "./AnimatedNumber";

const Dash = ({ totalSpending, searchInput }) => {
  return (
    <div className={container}>
      <AnimatedNumber
        className={amount}
        number={totalSpending}
        transform={(num) =>
          "Rs " +
          num.toLocaleString("en", {
            useGrouping: true,
            maximumFractionDigits: 0,
          })
        }
      />
      <div className={timeframe}>
        spent last month {searchInput ? `on ${searchInput}` : null}
      </div>
    </div>
  );
};

export default Dash;
