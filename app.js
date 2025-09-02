
import {
  auth, db, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updatePassword,
  doc, setDoc, getDoc, updateDoc, addDoc, getDocs, collection, query, where, serverTimestamp, orderBy
} from './firebase.js';

// ---- Helpers ----
const $ = (sel) => document.querySelector(sel);
const fmtMoney = (v) => v?.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) || 'R$ 0,00';
const todayISO = () => new Date().toISOString().split("T")[0];
const formatISOtoBR = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('pt-BR');
};

// ---- Estado global ----
let currentUser = null;
let currentUserDoc = null;
let currentCaixaRef = null;

// ---- Autenticação ----
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    const userDoc = await getDoc(doc(db, "users", user.uid));
    currentUserDoc = userDoc.data();
    if (!currentUserDoc) return;
    $('#loginScreen').style.display = 'none';
    $('#mainScreen').style.display = 'block';
    $('#welcomeUser').textContent = `Bem-vindo, ${currentUserDoc.nome}`;
    await checkCaixaAberto();
  } else {
    currentUser = null;
    currentUserDoc = null;
    $('#loginScreen').style.display = 'block';
    $('#mainScreen').style.display = 'none';
  }
});

$('#btnLogin').addEventListener('click', async () => {
  const matricula = $('#loginMatricula').value.trim();
  const senha = $('#loginSenha').value;
  const snap = await getDocs(query(collection(db, "users"), where("matricula", "==", matricula)));
  if (snap.empty) return alert("Matrícula não encontrada.");
  const user = snap.docs[0];
  try {
    await signInWithEmailAndPassword(auth, user.data().email, senha);
  } catch (err) {
    alert("Erro no login.");
  }
});

$('#btnLogout').addEventListener('click', () => signOut(auth));

$('#btnRegister').addEventListener('click', async () => {
  const matricula = $('#regMatricula').value.trim();
  const nome = $('#regNome').value.trim();
  const senha = $('#regSenha').value;
  const email = `${matricula}@fake.com`;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, senha);
    await setDoc(doc(db, "users", cred.user.uid), { matricula, nome, email });
    alert("Usuário cadastrado!");
    $('#registerScreen').style.display = 'none';
    $('#loginScreen').style.display = 'block';
  } catch (err) {
    alert("Erro ao registrar.");
  }
});

// ---- Caixa ----
async function checkCaixaAberto() {
  const caixasRef = collection(db, "users", currentUser.uid, "caixas");
  const qs = await getDocs(query(caixasRef, where("status", "==", "aberto")));
  if (!qs.empty) {
    const caixa = qs.docs[0];
    currentCaixaRef = { userId: currentUser.uid, caixaId: caixa.id };
    $('#caixaStatus').textContent = "Caixa Aberto";
    await renderParcial();
  } else {
    currentCaixaRef = null;
    $('#caixaStatus').textContent = "Nenhum caixa aberto";
  }
}

$('#btnAbrirCaixa').addEventListener('click', async () => {
  const ref = await addDoc(collection(db, "users", currentUser.uid, "caixas"), {
    status: "aberto",
    data: todayISO(),
    createdAt: serverTimestamp()
  });
  currentCaixaRef = { userId: currentUser.uid, caixaId: ref.id };
  $('#caixaStatus').textContent = "Caixa Aberto";
});

$('#btnFecharCaixa').addEventListener('click', async () => {
  if (!currentCaixaRef) return alert("Nenhum caixa aberto.");
  await updateDoc(doc(db, "users", currentCaixaRef.userId, "caixas", currentCaixaRef.caixaId), {
    status: "fechado",
    closedAt: serverTimestamp()
  });
  gerarRelatorioPDF();
  currentCaixaRef = null;
  $('#caixaStatus').textContent = "Caixa Fechado";
});

// ---- Lançamentos ----
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
  
  const ref = collection(
    db, 
    'users', 
    currentCaixaRef.userId, 
    'caixas', 
    currentCaixaRef.caixaId, 
    'lancamentos'
  );

  await addDoc(ref, dados);
  await renderParcial();
  printThermalReceipt(dados);

  // 🔹 limpar os campos após salvar
  tipoVal.value = "PRODATA";
  qtdBordos.value = 1;
  valor.value = "";
  prefixo.value = "";
  dataCaixa.value = todayISO();
  matMotorista.value = "";
});

// ---- Renderização parcial ----
async function renderParcial() {
  if (!currentCaixaRef) return;
  const ref = collection(db, "users", currentCaixaRef.userId, "caixas", currentCaixaRef.caixaId, "lancamentos");
  const qs = await getDocs(ref);
  let total = 0;
  qs.forEach(d => total += Number(d.data().valor || 0));
  $('#totalParcial').textContent = fmtMoney(total);
}

// ---- PDF relatório ----
async function gerarRelatorioPDF() {
  const { jsPDF } = window.jspdf;
  const docpdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const uid = currentCaixaRef.userId;
  const cid = currentCaixaRef.caixaId;

  const logo = new Image(); logo.src = "./assets/logo.png";

  logo.onload = async () => {
    const pageWidth = docpdf.internal.pageSize.getWidth();
    const logoWidth = 120; const logoHeight = 60;
    const logoX = (pageWidth - logoWidth) / 2;
    docpdf.addImage(logo, 'PNG', logoX, 30, logoWidth, logoHeight);

    docpdf.setDrawColor(0, 128, 0); docpdf.setLineWidth(1.2);
    docpdf.line(40, 100, pageWidth - 40, 100);

    let y = 120;
    docpdf.setFont('helvetica','bold'); docpdf.setFontSize(16);
    docpdf.text('Relatório de Fechamento de Caixa', pageWidth / 2, y, { align: 'center' });
    y += 30;

    docpdf.setFontSize(11); docpdf.setFont('helvetica','normal');
    const hoje = new Date();
    const dataHoraBR = hoje.toLocaleDateString('pt-BR') + " " + hoje.toLocaleTimeString('pt-BR');

    const caixaSnap = await getDoc(doc(db, 'users', uid, 'caixas', cid));
    const caixaData = caixaSnap.data();
    let aberturaTxt = "";
    if (caixaData?.data) {
      const aberturaHora = caixaData?.createdAt?.toDate ? caixaData.createdAt.toDate().toLocaleTimeString("pt-BR") : "";
      aberturaTxt = formatISOtoBR(caixaData.data) + (aberturaHora ? " " + aberturaHora : "");
    }

    docpdf.text(`Operador: ${currentUserDoc.nome}  • Matrícula: ${currentUserDoc.matricula}`, 40, y); y += 16;
    if (aberturaTxt) { docpdf.text(`Abertura do caixa: ${aberturaTxt}`, 40, y); y += 16; }
    docpdf.text(`Data do fechamento: ${dataHoraBR}`, 40, y); y += 22;

    // --- Lançamentos ---
    const lref = collection(db, 'users', uid, 'caixas', cid, 'lancamentos');
    const lqs = await getDocs(query(lref, orderBy('createdAt','asc')));
    const lancamentosBody = []; let total = 0;
    lqs.forEach(d => {
      const x = d.data(); total += Number(x.valor || 0);
      const horaLancamento = x.createdAt?.toDate ? x.createdAt.toDate().toLocaleTimeString("pt-BR") : '';
      lancamentosBody.push([
        horaLancamento,
        formatISOtoBR(x.dataCaixa),
        x.prefixo||'',
        x.tipoValidador||'',
        x.qtdBordos||'',
        fmtMoney(x.valor)||'R$ 0,00',
        x.matriculaMotorista||''
      ]);
    });

    docpdf.autoTable({
      startY: y,
      head: [['Horário','Data','Prefixo','Validador','Qtd Bordos','Valor','Motorista']],
      body: lancamentosBody,
      theme: 'grid',
      headStyles: { fillColor: [50,50,50], textColor: 255, halign: 'center' },
      bodyStyles: { halign: 'center' },
      columnStyles: {4:{halign:'center'},5:{halign:'right'}}
    });

    y = docpdf.lastAutoTable.finalY + 20;

    // --- Sangrias ---
    const sref = collection(db, 'users', uid, 'caixas', cid, 'sangrias');
    const sqs = await getDocs(query(sref, orderBy('createdAt','asc')));
    const sangriasBody = []; let totalS = 0;
    if (!sqs.empty) {
      sqs.forEach(d => { const x = d.data(); totalS += Number(x.valor||0); sangriasBody.push([fmtMoney(x.valor), x.motivo||'']); });
    } else sangriasBody.push(['R$ 0,00', 'Nenhuma']);

    docpdf.autoTable({
      startY: y,
      head: [['Valor','Motivo']],
      body: sangriasBody,
      theme: 'grid',
      headStyles: { fillColor: [50,50,50], textColor: 255, halign: 'center' },
      bodyStyles: { halign: 'center' }
    });

    y = docpdf.lastAutoTable.finalY + 14;
    docpdf.text(`Total Lançamentos: ${fmtMoney(total)}`, 40, y); y+=14;
    docpdf.text(`Total Sangrias: ${fmtMoney(totalS)}`, 40, y); y+=14;
    docpdf.text(`Total Corrigido: ${fmtMoney(total - totalS)}`, 40, y); y+=22;

    // 🔹 Nome do arquivo: matricula-data_hora.pdf
    const matricula = currentUserDoc.matricula;
    const agora = new Date();
    const dataBR = agora.toLocaleDateString("pt-BR").replace(/\//g, "-");
    const horaBR = agora.toLocaleTimeString("pt-BR", { hour12: false }).replace(/:/g, "-");
    const nomeArquivo = `${matricula}-${dataBR}_${horaBR}.pdf`;

    docpdf.save(nomeArquivo);
  };
}
