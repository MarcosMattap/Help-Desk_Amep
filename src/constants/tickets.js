const ALLOWED_TICKET_STATUSES = [
  "aberto",
  "em_andamento",
  "pausa",
  "aguardando_usuario",
  "resolvido",
  "fechado",
];

const ALLOWED_TICKET_PRIORITIES = ["baixa", "media", "alta", "critica"];

function isValidTicketStatus(status) {
  return ALLOWED_TICKET_STATUSES.includes(status);
}

function isValidTicketPriority(priority) {
  return ALLOWED_TICKET_PRIORITIES.includes(priority);
}

module.exports = {
  ALLOWED_TICKET_STATUSES,
  ALLOWED_TICKET_PRIORITIES,
  isValidTicketStatus,
  isValidTicketPriority,
};
