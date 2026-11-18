const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());
app.use(cors());


// 1) CLIENTE DE IA (OpenRouter)

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://tu-sitio-web.com', // Opcional
    'X-Title': 'Mi Aplicativo Web',             // Opcional
  },
});


// 2) CONEXIÓN A LA BASE DE DATOS

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME || 'sakila',
  charset: 'utf8mb4',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 5,
});


// 3) HERRAMIENTAS

const MAX_FILAS = 100;
const MAX_CARACTERES = 20000;

async function obtener_esquema() {
  try {
    const [rows] = await pool.query(
      `SELECT c.TABLE_NAME AS tabla, c.COLUMN_NAME AS columna,
              c.COLUMN_TYPE AS tipo, c.COLUMN_KEY AS llave
         FROM INFORMATION_SCHEMA.COLUMNS c
         JOIN INFORMATION_SCHEMA.TABLES t
           ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      [process.env.DB_NAME || 'sakila']
    );
    const tablas = {};
    for (const r of rows) {
      const marca = r.llave === 'PRI' ? ' [PK]' : r.llave === 'MUL' ? ' [FK/idx]' : '';
      (tablas[r.tabla] ||= []).push(`${r.columna} ${r.tipo}${marca}`);
    }
    return Object.entries(tablas).map(([t, cols]) => `${t}(${cols.join(', ')})`).join('\n');
  } catch (e) {
    return `Error al obtener el esquema: ${e.message}`;
  }
}

const PALABRAS_PROHIBIDAS =
  /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|handler|load|outfile|dumpfile|sleep|benchmark)\b/i;

function validarSoloLectura(sql) {
  if (sql.includes(';')) return 'No se permiten múltiples sentencias ni ";" dentro de la consulta.';
  if (/--|\/\*|#/.test(sql)) return 'No se permiten comentarios SQL.';
  if (!/^(select|with)\b/i.test(sql)) return 'Solo se permiten consultas SELECT.';
  if (PALABRAS_PROHIBIDAS.test(sql)) return 'La consulta contiene una operación no permitida (solo lectura).';
  return null;
}

async function ejecutar_consulta_sql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return 'Error: no se recibió ninguna consulta SQL.';

  let consulta = sql.trim().replace(/;+\s*$/, '');
  const error = validarSoloLectura(consulta);
  if (error) return `Error de seguridad: ${error}`;
  if (!/\blimit\s+\d+/i.test(consulta)) consulta += ` LIMIT ${MAX_FILAS}`;

  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [rows] = await conn.query(consulta);
    await conn.query('ROLLBACK');
    let texto = JSON.stringify(rows);
    if (texto.length > MAX_CARACTERES) {
      texto = texto.slice(0, MAX_CARACTERES) + '... [resultado truncado, usa LIMIT o más filtros]';
    }
    return texto;
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch (_) {}
    return `Error SQL: ${e.message}`; 
  } finally {
    conn.release();
  }
}


// 4) manual de instrucciones para la IA

const tools = [
  {
    type: 'function',
    function: {
      name: 'obtener_esquema',
      description:
        'Devuelve todas las tablas de la base de datos Sakila con sus columnas, tipos y llaves. Úsala cuando necesites saber qué tablas y columnas existen antes de escribir una consulta.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ejecutar_consulta_sql',
      description:
        'Ejecuta una consulta SELECT de solo lectura sobre la base de datos Sakila (MariaDB) y devuelve las filas en JSON. Puedes usar JOIN entre varias tablas, GROUP BY, subconsultas y funciones como DAYNAME(). Si la consulta falla, lee el error y corrígela.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Consulta SELECT completa, sin punto y coma ni comentarios.' },
        },
        required: ['sql'],
      },
    },
  },
];

const funciones = { obtener_esquema, ejecutar_consulta_sql };


// 5) INSTRUCCIONES DEL AGENTE

const MAX_ITERACIONES = 8;

const SYSTEM_PROMPT = `Eres un analista de datos de una tienda de renta de películas (base de datos Sakila, MariaDB).
Responde siempre en español, con datos reales obtenidos de la base de datos. Nunca inventes cifras.
Usa las herramientas: si no estás seguro de las tablas o columnas, llama primero a obtener_esquema.
Escribe consultas SELECT con JOIN entre las tablas necesarias para no limitar el análisis.

Relaciones principales de Sakila:
- film(film_id, title, length [minutos], rental_rate, rating)
- film_category(film_id, category_id) -> category(category_id, name)
- inventory(inventory_id, film_id, store_id)
- rental(rental_id, rental_date, return_date, inventory_id, customer_id, staff_id)
- payment(payment_id, customer_id, rental_id, amount, payment_date, staff_id)
- customer(customer_id, store_id, first_name, last_name, email, active)
- store(store_id), staff(staff_id, store_id)
Cadena típica: film -> inventory -> rental -> customer / payment.

Reglas importantes:
- Los datos son de 2005-2006. La fecha de referencia para "hoy" es MAX(rental_date) de la tabla rental, NUNCA NOW().
- "Larga" significa film.length > 120 (minutos).
- "Acción" significa category.name = 'Action'; no uses film.rating para identificar películas de acción.
- "Alquilada muy seguido" significa muchos registros en rental (COUNT) para esa película.
- Clientes en riesgo de abandono: los de mayor tiempo desde su último alquiler (MAX(rental_date) por cliente) comparado con la fecha de referencia.
- Día de la semana: usa DAYNAME(rental_date) para movimiento (cantidad de alquileres) y DAYNAME(payment_date) para dinero. Para el promedio de dinero recaudado por día, primero suma por fecha (DATE) y luego promedia esos totales por día de la semana.
- Al final, explica brevemente tu conclusión y menciona los datos clave que la sustentan.`;

// 6) RUTA DEL CHAT

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Debes enviar un mensaje.' });
    }
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'El servidor no tiene configurada la clave de OpenRouter.' });
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: message.trim() },
    ];

    for (let i = 1; i <= MAX_ITERACIONES; i++) {
      const completion = await openrouter.chat.completions.create({
        model: 'openai/gpt-4o-mini',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.1,
      });

      if (!completion.choices || completion.choices.length === 0) {
        throw new Error('La IA no devolvió respuesta.');
      }

      const respuestaIA = completion.choices[0].message;
      messages.push(respuestaIA);

      if (respuestaIA.tool_calls && respuestaIA.tool_calls.length > 0) {
        for (const toolCall of respuestaIA.tool_calls) {
          const nombre = toolCall.function.name;
          let argumentos = {};
          try { argumentos = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) {}

          console.log(`\n[Iteración ${i}] La IA decidió usar: ${nombre}`);
          console.log('Argumentos:', argumentos);

          let resultado;
          const fn = funciones[nombre];
          if (!fn) resultado = `Herramienta ${nombre} no encontrada.`;
          else if (nombre === 'ejecutar_consulta_sql') resultado = await fn(argumentos.sql);
          else resultado = await fn();

          console.log('Resultado (primeros 300 caracteres):', String(resultado).slice(0, 300));

          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: String(resultado) });
        }
        continue;
      }

      return res.json({ reply: respuestaIA.content });
    }

    res.json({ reply: 'No pude completar el análisis en el número máximo de pasos. Intenta reformular la pregunta.' });
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    res.status(500).json({ error: 'Error interno al procesar la solicitud con la IA' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});