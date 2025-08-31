import {
  auth, db, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updatePassword,
  doc, setDoc, getDoc, updateDoc, addDoc, getDocs, collection, query, where, serverTimestamp, orderBy
} from './firebase.js';

// ---- Helpers ----
const $ = (sel) => document.querySelector(sel);
const fmtMoney = (v) => (Number(v || 0)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Função para pegar a data local no formato YYYY-MM-DD
const todayISO = () => {
  const d = new Date();
  return d.toLocaleDateString('pt-BR').split('/').reverse().join('-');
};

// Função auxiliar para formatar YYYY-MM-DD → DD/MM/YYYY (única declaração!)
function formatISOtoBR(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

const adminsMat = new Set(['4144','70029','6266']);
const emailFromMat = (mat) => `${mat}@movebuss.com`;

// State
let currentUserDoc = null;
let currentCaixaRef = null;

// Elements
const authArea = $('#authArea');
const appArea = $('#appArea');
const userBadge = $('#userBadge');
const btnLogin = $('#btnLogin');
const btnRegistrar = $('#btnRegistrar');
const btnLogout = $('#btnLogout');
const btnChangePass = $('#btnChangePass');
const btnAbrir = $('#btnAbrir');
const btnFechar = $('#btnFechar');
const caixaStatusEl = $('#caixaStatus');

// Forms
const loginMatricula = $('#loginMatricula');
const loginSenha = $('#loginSenha');
const cadNome = $('#cadNome');
const cadMatricula = $('#cadMatricula');
const cadSenha = $('#cadSenha');

const lancBox = $('#lancamentoBox');
const sangriaBox = $('#sangriaBox');
const relatorioLista = $('#relatorioLista');
const matRecebedor = $('#matRecebedor');

const qtdBordos = $('#qtdBordos');
const valor = $('#valor');
const tipoVal = $('#tipoVal');
const prefixo = $('#prefixo');
const dataCaixa = $('#dataCaixa');
const matMotorista = $('#matMotorista');

// Update valor automatico = qtd * 5
const updateValor = () => {
  const q = Number(qtdBordos.value || 0);
  valor.value = (q * 5).toFixed(2);
};
qtdBordos.addEventListener('input', updateValor);

// Prefixo: only digits and max 3
prefixo.addEventListener('input', () => {
  prefixo.value = prefixo.value.replace(/\D/g, '').slice(0,3);
});

// Date default
dataCaixa.value = todayISO();

// ---- Auth flows ----
btnRegistrar.addEventListener('click', async () => {
  const nome = cadNome.value.trim();
  const mat = cadMatricula.value.trim();
  const senha = cadSenha.value;
  if (!nome || !mat || !senha) return alert('Preencha nome, matrícula e senha.');

  try {
    const cred = await createUserWithEmailAndPassword(auth, emailFromMat(mat), senha);
    const isAdmin = adminsMat.has(mat);
    await setDoc(doc(db, 'users', cred.user.uid), {
      nome, matricula: mat, admin: isAdmin, createdAt: serverTimestamp()
    });
    alert('Conta criada! Faça login com sua matrícula e senha.');
    cadNome.value = cadMatricula.value = cadSenha.value = '';
    loginMatricula.value = mat;
    loginSenha.value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    console.error(e);
    alert('Erro ao criar conta: ' + (e?.message || e));
  }
});

btnLogin.addEventListener('click', async () => {
  const mat = loginMatricula.value.trim();
  const senha = loginSenha.value;
  if (!mat || !senha) return alert('Informe matrícula e senha.');
  try {
    await signInWithEmailAndPassword(auth, emailFromMat(mat), senha);
  } catch (e) {
    console.error(e);
    alert('Falha no login: ' + (e?.message || e));
  }
});

btnLogout.addEventListener('click', async () => { await signOut(auth); });

btnChangePass.addEventListener('click', async () => {
  const nova = prompt('Digite a nova senha:');
  if (!nova) return;
  try { await updatePassword(auth.currentUser, nova); alert('Senha alterada com sucesso.'); }
  catch (e) { alert('Erro ao alterar senha: ' + (e?.message || e)); }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authArea.classList.remove('hidden');
    appArea.classList.add('hidden');
    userBadge.classList.add('hidden');
    btnLogout.classList.add('hidden');
    btnChangePass.classList.add('hidden');
    currentUserDoc = null;
    currentCaixaRef = null;
    return;
  }
  const uref = doc(db, 'users', user.uid);
  const snap = await getDoc(uref);
  currentUserDoc = snap.data();
  if (adminsMat.has(currentUserDoc?.matricula) && !currentUserDoc.admin) {
    await updateDoc(uref, { admin: true });
    currentUserDoc.admin = true;
  }
  authArea.classList.add('hidden');
  appArea.classList.remove('hidden');
  btnLogout.classList.remove('hidden');
  btnChangePass.classList.remove('hidden');
  matRecebedor.value = currentUserDoc.matricula;
  userBadge.textContent = `${currentUserDoc.nome} • ${currentUserDoc.matricula}`;
  userBadge.classList.remove('hidden');
  if (currentUserDoc.admin) userBadge.classList.add('admin'); else userBadge.classList.remove('admin');

  await detectOrUpdateCaixaStatus();
});

async function detectOrUpdateCaixaStatus() {
  const uid = auth.currentUser.uid;
  const q1 = query(collection(db, 'users', uid, 'caixas'), where('status', '==', 'aberto'));
  const abertos = await getDocs(q1);
  if (!abertos.empty) {
    const docRef = abertos.docs[0].ref;
    currentCaixaRef = { userId: uid, caixaId: docRef.id };
    setStatusUI('aberto');
    enableWorkflows(true);
    await renderParcial();
  } else {
    currentCaixaRef = null;
    setStatusUI('fechado');
    enableWorkflows(false);
    relatorioLista.textContent = 'Sem lançamentos. Abra um caixa para iniciar.';
  }
}

function setStatusUI(status) { caixaStatusEl.textContent = status === 'aberto' ? 'Caixa Aberto' : 'Caixa Fechado'; }
function enableWorkflows(aberto) { btnAbrir.disabled = !!aberto; btnFechar.disabled = !aberto; lancBox.classList.toggle('hidden', !aberto); sangriaBox.classList.toggle('hidden', !aberto); }

// ---- Caixa controls ----
btnAbrir.addEventListener('click', async () => {
  const uid = auth.currentUser.uid;
  const q1 = query(collection(db, 'users', uid, 'caixas'), where('status', '==', 'aberto'));
  const openDocs = await getDocs(q1);
  if (!openDocs.empty) return alert('Você já possui um caixa aberto.');
  const caixa = {
    status: 'aberto',
    createdAt: serverTimestamp(),
    data: dataCaixa.value,
    matricula: currentUserDoc.matricula,
    nome: currentUserDoc.nome
  };
  const ref = await addDoc(collection(db, 'users', uid, 'caixas'), caixa);
  currentCaixaRef = { userId: uid, caixaId: ref.id };
  setStatusUI('aberto');
  enableWorkflows(true);
  await renderParcial();
  alert('Caixa aberto com sucesso.');
});

btnFechar.addEventListener('click', async () => {
  if (!currentCaixaRef) return;
  await gerarRelatorioPDF();
  const ref = doc(db, 'users', currentCaixaRef.userId, 'caixas', currentCaixaRef.caixaId);
  await updateDoc(ref, { status: 'fechado', closedAt: serverTimestamp() });
  currentCaixaRef = null;
  setStatusUI('fechado');
  enableWorkflows(false);
  relatorioLista.textContent = 'Caixa encerrado. Abra um novo quando necessário.';
});

// ---- Lançamentos e Recibos ----
$('#btnSalvarLanc').addEventListener('click', async () => {
  if (!currentCaixaRef) return alert('Abra um caixa primeiro.');
  const dados = {
    tipoValidador: tipoVal.value,
    qtdBordos: Number(qtdBordos.value || 0),
    valor: Number(valor.value || 0),
    prefixo: '55' + (prefixo.value || '000'),
    dataCaixa: dataCaixa.value,
    matriculaMotorista: (matMotorista.value || '').trim(),
    matriculaRecebedor: currentUserDoc.matricula,
    createdAt: serverTimestamp()
  };
  if (!dados.qtdBordos || !dados.matriculaMotorista) return alert('Informe a quantidade e a matrícula do motorista.');

  const ref = collection(db, 'users', currentCaixaRef.userId, 'caixas', currentCaixaRef.caixaId, 'lancamentos');
  await addDoc(ref, dados);

  await renderParcial();
  printThermalReceipt(dados);
});

$('#btnRegistrarSangria').addEventListener('click', async () => {
  if (!currentCaixaRef) return alert('Abra um caixa primeiro.');
  const valor = Number($('#sangriaValor').value || 0);
  const motivo = ($('#sangriaMotivo').value || '').trim();
  if (valor <= 0 || !motivo) return alert('Informe valor e motivo da sangria.');
  const ref = collection(db, 'users', currentCaixaRef.userId, 'caixas', currentCaixaRef.caixaId, 'sangrias');
  await addDoc(ref, { valor, motivo, createdAt: serverTimestamp() });
  $('#sangriaValor').value = ''; $('#sangriaMotivo').value='';
  await renderParcial();
  alert('Sangria registrada.');
});

// ---- Render parcial (relatório tela) ----
async function renderParcial() {
  const base = `Usuário: ${currentUserDoc.nome} • Matrícula: ${currentUserDoc.matricula}\n`;
  const lref = collection(db, 'users', currentCaixaRef.userId, 'caixas', currentCaixaRef.caixaId, 'lancamentos');
  const lqs = await getDocs(query(lref, orderBy('createdAt','asc')));
  const sref = collection(db, 'users', currentCaixaRef.userId, 'caixas', currentCaixaRef.caixaId, 'sangrias');
  const sqs = await getDocs(query(sref, orderBy('createdAt','asc')));

  let total = 0;
  let out = base + '\nLANÇAMENTOS:\n';
  lqs.forEach(d => {
    const x = d.data();
    total += Number(x.valor||0);
    out += `• ${formatISOtoBR(x.dataCaixa)} ${x.prefixo} ${x.tipoValidador} Qtd:${x.qtdBordos} Valor:${fmtMoney(x.valor)} Mot:${x.matriculaMotorista}\n`;
  });

  let totalS = 0;
  if (!sqs.empty) {
    out += '\nSANGRIAS:\n';
    sqs.forEach(d => {
      const x = d.data();
      totalS += Number(x.valor||0);
      out += `• ${fmtMoney(x.valor)} — ${x.motivo}\n`;
    });
  }

  out += `\nTOTAL LANÇAMENTOS: ${fmtMoney(total)}\n`;
  out += `TOTAL SANGRIAS: ${fmtMoney(totalS)}\n`;
  out += `TOTAL CORRIGIDO: ${fmtMoney(total - totalS)}\n`;

  relatorioLista.textContent = out;
}

// ---- Recibo térmico ----
function printThermalReceipt(data) {
  const win = window.open('', '_blank', 'width=400,height=800');
  const now = new Date();
  const dt = now.toLocaleString('pt-BR');
  const dataCaixaBR = formatISOtoBR(data.dataCaixa);

  const html = `<!DOCTYPE html>
  <html><head><meta charset="utf-8">
  <title>Recibo</title>
  <style>
    @page { size: 80mm 148mm; margin: 0mm; }
    body { font-family: "Lucida Sans", Courier, monospace; font-size: 12px; margin: 0; padding: 0; }
    h1 { text-align: center; font-size: 15px; margin: 8px 0 12px; margin-left: -25px; }
    .mono { font-family: "Lucida Sans", monospace; white-space: pre-wrap; }
  </style></head>
  <body onload="window.print(); setTimeout(()=>window.close(), 500);">
    <h1>RECIBO DE PAGAMENTO MANUAL</h1>
--------------------------------------------------------------------
    <div class="mono">
  <strong>Matricula Motorista:</strong> ${data.matriculaMotorista}<br>
  <strong>Tipo de Validador:</strong> ${data.tipoValidador}<br>
  <strong>Prefixo:</strong> ${data.prefixo}<br>
--------------------------------------------------------------------
  <strong>Data do Caixa:</strong> ${dataCaixaBR}<br>  
  <strong>Quantidade bordos:</strong> ${data.qtdBordos}<br>
  <strong>Valor:</strong> R$ ${Number(data.valor).toFixed(2)}<br> 
--------------------------------------------------------------------
  <strong>Matricula Recebedor:</strong> ${data.matriculaRecebedor}<br>
  <strong>Data Recebimento:</strong> ${dt}<br><br>
  <strong>Assinatura Recebedor:</strong><br>
         ________________________________
    </div>
  </body></html>`;

  win.document.write(html);
  win.document.close();
}

// ---- PDF relatório ----
async function gerarRelatorioPDF() {
  const { jsPDF } = window.jspdf;
  const docpdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const uid = currentCaixaRef.userId;
  const cid = currentCaixaRef.caixaId;

  const logo = new Image();
  logo.src = "./assets/logo.png";

  logo.onload = async () => {
    const pageWidth = docpdf.internal.pageSize.getWidth();
    const logoWidth = 120;
    const logoHeight = 60;
    const logoX = (pageWidth - logoWidth) / 2;
    docpdf.addImage(logo, 'PNG', logoX, 30, logoWidth, logoHeight);

    docpdf.setDrawColor(0, 128, 0);
    docpdf.setLineWidth(1.2);
    docpdf.line(40, 100, pageWidth - 40, 100);

    let y = 120;
    docpdf.setFont('helvetica','bold');
    docpdf.setFontSize(16);
    docpdf.text('Relatório de Fechamento de Caixa', pageWidth / 2, y, { align: 'center' });
    y += 30;

    docpdf.setFontSize(11);
    docpdf.setFont('helvetica','normal');

    const hoje = new Date();
    const dataHoraBR = hoje.toLocaleDateString('pt-BR') + " " + hoje.toLocaleTimeString('pt-BR');

    const caixaSnap = await getDoc(doc(db, 'users', uid, 'caixas', cid));
    const caixaData = caixaSnap.data();
    let aberturaTxt = "";
    if (caixaData?.data) {
      const aberturaHora = caixaData?.createdAt?.toDate 
                          ? caixaData.createdAt.toDate().toLocaleTimeString("pt-BR") 
                          : "";
      aberturaTxt = formatISOtoBR(caixaData.data) + (aberturaHora ? " " + aberturaHora : "");
    }

    docpdf.text(`Operador: ${currentUserDoc.nome}  • Matrícula: ${currentUserDoc.matricula}`, 40, y);
    y += 16;
    if (aberturaTxt) { docpdf.text(`Abertura do caixa: ${aberturaTxt}`, 40, y); y += 16; }
    docpdf.text(`Data do fechamento: ${dataHoraBR}`, 40, y);
    y += 22;

    const lref = collection(db, 'users', uid, 'caixas', cid, 'lancamentos');
    const lqs = await getDocs(query(lref, orderBy('createdAt','asc')));
    const lancamentosBody = [];
    let total = 0;
    lqs.forEach(d => {
      const x = d.data();
      lancamentosBody.push([
        formatISOtoBR(x.dataCaixa),
        x.prefixo || '',
        x.tipoValidador || '',
        x.qtdBordos || '',
        fmtMoney(x.valor) || 'R$ 0,00',
        x.matriculaMotorista || ''
      ]);
      total += Number(x.valor || 0);
    });

    docpdf.autoTable({
      startY: y,
      head: [['Data Caixa','Prefixo','Validador','Qtd Bordos','Valor','Motorista']],
      body: lancamentosBody,
      theme: 'grid',
      headStyles: { fillColor: [200,200,200], textColor: 20, fontStyle: 'bold' },
      styles: { fontSize: 10, halign: 'center' },
      columnStyles: { 0: { halign: 'center' }, 1: { halign: 'center' }, 2: { halign: 'center' }, 3: { halign: 'center' }, 4: { halign: 'right' }, 5: { halign: 'center' } }
    });

    let y2 = docpdf.lastAutoTable.finalY + 20;

    const sref = collection(db, 'users', uid, 'caixas', cid, 'sangrias');
    const sqs = await getDocs(query(sref, orderBy('createdAt','asc')));
    const sangriasBody = [];
    let totalS = 0;
    if (sqs.empty) { sangriasBody.push(['— Nenhuma', '']); } 
    else { sqs.forEach(d => { const x=d.data(); sangriasBody.push([fmtMoney(x.valor), x.motivo||'']); totalS+=Number(x.valor||0); }); }

    docpdf.autoTable({
      startY: y2,
      head: [['Valor','Motivo']],
      body: sangriasBody,
      theme: 'grid',
      headStyles: { fillColor: [200,200,200], textColor: 20, fontStyle: 'bold' },
      styles: { fontSize: 10, halign: 'center' },
      columnStyles: { 0: { halign: 'right' }, 1: { halign: 'left' } }
    });

    y2 = docpdf.lastAutoTable.finalY + 20;

    docpdf.setFont('helvetica','bold');
    docpdf.text(`TOTAL LANÇAMENTOS: ${fmtMoney(total)}`, 40, y2); y2+=16;
    docpdf.text(`TOTAL SANGRIAS: ${fmtMoney(totalS)}`, 40, y2); y2+=16;
    docpdf.text(`TOTAL CORRIGIDO: ${fmtMoney(total - totalS)}`, 40, y2); y2+=22;
    docpdf.setFont('helvetica','normal');
    docpdf.text('Fechamento resumido. Documento gerado automaticamente.', 40, y2);

    const hojeNome = hoje.toLocaleDateString("pt-BR").replace(/\//g, "-");
    const fileName = `${currentUserDoc.matricula}-${hojeNome}.pdf`;

    docpdf.save(fileName);
  };
}
