import { container, amount, timeframe } from "../css/NewDash.module.css";
import AnimatedNumber from "./AnimatedNumber";

const NewDash = ({ totalSpending }) => {
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
      <div className={timeframe}>spent last month</div>
    </div>
  );
};

export default NewDash;
