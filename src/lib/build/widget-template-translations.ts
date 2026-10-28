import type { WidgetTranslations } from "./widget-i18n"

// Each template carries only its own copy so the Translations editor stays focused.
type Text = [original: string, portuguese: string, spanish: string]
const name: Text = ["Name", "Nome", "Nombre"]
const email: Text = ["Email", "E-mail", "Correo electrónico"]
const help: Text = [
  "How can we help?",
  "Como podemos ajudar?",
  "¿Cómo podemos ayudarte?",
]
const sales: Text = ["Talk to sales", "Fale com vendas", "Habla con ventas"]

const copy: Record<string, Text[]> = {
  "contact-form": [
    ["Get in touch", "Entre em contato", "Ponte en contacto"],
    [
      "Tell us how we can help.",
      "Conte como podemos ajudar.",
      "Cuéntanos cómo podemos ayudarte.",
    ],
    name,
    email,
    ["Message", "Mensagem", "Mensaje"],
    ["Send message", "Enviar mensagem", "Enviar mensaje"],
  ],
  "demo-request": [
    sales,
    [
      "Tell us about your company and what you need.",
      "Conte sobre sua empresa e o que você precisa.",
      "Cuéntanos sobre tu empresa y lo que necesitas.",
    ],
    name,
    ["Work email", "E-mail profissional", "Correo de trabajo"],
    ["Phone number", "Telefone", "Teléfono"],
    ["Company size", "Tamanho da empresa", "Tamaño de la empresa"],
    help,
    ["Request a demo", "Solicitar demonstração", "Solicitar una demo"],
  ],
  "support-request": [
    ["Contact support", "Fale com o suporte", "Contacta con soporte"],
    [
      "Share the details so we can help.",
      "Compartilhe os detalhes para podermos ajudar.",
      "Comparte los detalles para que podamos ayudarte.",
    ],
    email,
    ["Subject", "Assunto", "Asunto"],
    ["What happened?", "O que aconteceu?", "¿Qué ocurrió?"],
    ["Send request", "Enviar solicitação", "Enviar solicitud"],
  ],
  "quick-choices": [
    help,
    sales,
    [
      "Choose a topic to continue.",
      "Escolha um assunto para continuar.",
      "Elige un tema para continuar.",
    ],
    ["Get support", "Obter ajuda", "Obtener ayuda"],
    ["Check an order", "Consultar um pedido", "Consultar un pedido"],
  ],
  "order-lookup": [
    ["Find your order", "Encontre seu pedido", "Encuentra tu pedido"],
    [
      "Enter the details used when placing your order.",
      "Informe os dados usados ao fazer o pedido.",
      "Introduce los datos que usaste al hacer el pedido.",
    ],
    ["Order reference", "Número do pedido", "Número de pedido"],
    email,
    ["Find order", "Buscar pedido", "Buscar pedido"],
  ],
  "order-summary": [
    ["Order summary", "Resumo do pedido", "Resumen del pedido"],
    [
      "Example data. Replace this with the result of your order action.",
      "Dados de exemplo. Substitua pelo resultado da sua ação de pedidos.",
      "Datos de ejemplo. Sustitúyelos por el resultado de tu acción de pedidos.",
    ],
    ["Order:", "Pedido:", "Pedido:"],
    ["Status:", "Status:", "Estado:"],
    ["Processing", "Em processamento", "En proceso"],
    ["Example item", "Item de exemplo", "Artículo de ejemplo"],
  ],
  "buy-products": [
    ["Select products", "Selecione os produtos", "Selecciona los productos"],
    ["Training shoes", "Tênis de treino", "Zapatillas de entrenamiento"],
    ["Running shoes", "Tênis de corrida", "Zapatillas para correr"],
    ["Add to cart", "Adicionar ao carrinho", "Añadir al carrito"],
  ],
  "get-cart": [
    [
      "{{count}} items in cart",
      "{{count}} itens no carrinho",
      "{{count}} artículos en el carrito",
    ],
    ["Cloud / Size 9", "Cloud / Tamanho 9", "Cloud / Talla 9"],
    ["Cloud / Size 8", "Cloud / Tamanho 8", "Cloud / Talla 8"],
    ["Qty", "Qtd.", "Cant."],
    ["Total due", "Total a pagar", "Total a pagar"],
    ["Continue to checkout", "Continuar para o pagamento", "Continuar al pago"],
  ],
  "usage-chart": [
    ["Usage", "Uso", "Uso"],
    [
      "Total credits used",
      "Total de créditos usados",
      "Total de créditos usados",
    ],
    ["Sun", "Dom", "Dom"],
    ["Mon", "Seg", "Lun"],
    ["Tue", "Ter", "Mar"],
    ["Wed", "Qua", "Mié"],
    ["Thu", "Qui", "Jue"],
    ["Fri", "Sex", "Vie"],
    ["Sat", "Sáb", "Sáb"],
  ],
  "gym-class-booking": [
    ["Upcoming classes", "Próximas aulas", "Próximas clases"],
    ["Morning yoga flow", "Yoga pela manhã", "Yoga por la mañana"],
    ["Strength foundations", "Fundamentos de força", "Fundamentos de fuerza"],
    ["Beginner", "Iniciante", "Principiante"],
    ["All levels", "Todos os níveis", "Todos los niveles"],
    ["Mon · 7:30 AM", "Seg · 7h30", "Lun · 7:30"],
    ["Wed · 6:00 PM", "Qua · 18h", "Mié · 18:00"],
    ["Fitness studio", "Estúdio de exercícios", "Estudio de fitness"],
    ["Book class", "Reservar aula", "Reservar clase"],
  ],
  "hotel-booking": [
    [
      "Boutique hotel bedroom",
      "Quarto de hotel boutique",
      "Habitación de hotel boutique",
    ],
    ["/ night", "/ noite", "/ noche"],
    ["Example property", "Hospedagem de exemplo", "Alojamiento de ejemplo"],
    ["Amenities", "Comodidades", "Servicios"],
    ["Breakfast", "Café da manhã", "Desayuno"],
    ["Parking", "Estacionamento", "Aparcamiento"],
    [
      "Check availability",
      "Verificar disponibilidade",
      "Consultar disponibilidad",
    ],
  ],
  "fetch-weather": [
    ["Sunny", "Ensolarado", "Soleado"],
    [
      "Clear skies and a light breeze through the afternoon.",
      "Céu limpo e brisa leve durante a tarde.",
      "Cielo despejado y brisa suave durante la tarde.",
    ],
    ["H", "Máx.", "Máx."],
    ["L", "Mín.", "Mín."],
    ["Refresh weather", "Atualizar previsão", "Actualizar el tiempo"],
  ],
}

export function widgetTemplateTranslations(id: string): WidgetTranslations {
  const texts = copy[id] ?? []
  return {
    "pt-BR": Object.fromEntries(texts.map(([key, pt]) => [key, pt])),
    es: Object.fromEntries(texts.map(([key, , es]) => [key, es])),
  }
}
