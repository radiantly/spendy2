import { FaCaretUp, FaCaretDown } from "react-icons/fa";
import { sortIcon, hidden } from "../css/TransactionRow.module.css";
const GridHeader = ({
  className,
  sortKey,
  children,
  sortOrder,
  setSortOrder,
}) => {
  const handleClick = (e) => {
    if (!sortKey) return;

    if (!sortOrder?.startsWith(sortKey)) return setSortOrder(`${sortKey}Desc`);
    if (sortOrder === `${sortKey}Desc`) return setSortOrder(`${sortKey}Asc`);
    return setSortOrder(null);
  };

  return (
    <div className={className} onClick={handleClick}>
      <div>{children}</div>
      <div
        className={[
          sortIcon,
          sortOrder?.startsWith(sortKey) ? "" : hidden,
        ].join(" ")}
      >
        {sortOrder?.endsWith("Asc") ? <FaCaretUp /> : <FaCaretDown />}
      </div>
    </div>
  );
};

export default GridHeader;
