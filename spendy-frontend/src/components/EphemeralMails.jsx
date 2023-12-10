import {
  date,
  payee,
  mode,
  amount,
  remarks,
  row,
  moreActions,
  ephemeral,
} from "../css/TransactionRow.module.css";
import { FaTimes } from "react-icons/fa";
import RawEmailModal from "./RawEmailModal";
import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
const EphemeralMails = ({ ephemeralMails, setEphemeralMails }) => {
  const [activeMail, setActiveMail] = useState(null);

  return (
    <>
      {ephemeralMails.map((mail, index) => (
        <div className={[row, ephemeral].join(" ")} key={index}>
          <div className={date}>-</div>
          <div className={payee}>{mail.from}</div>
          <div className={mode}>-</div>
          <div className={amount}>-</div>
          <div className={remarks} onClick={(e) => setActiveMail(mail)}>
            {mail.subject}
          </div>
          <div
            className={moreActions}
            onClick={() =>
              setEphemeralMails(ephemeralMails.filter((_, idx) => idx != index))
            }
          >
            <FaTimes />
          </div>
        </div>
      ))}

      <AnimatePresence>
        {activeMail ? (
          <RawEmailModal
            mail={activeMail}
            onClose={() => setActiveMail(null)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
};

export default EphemeralMails;
