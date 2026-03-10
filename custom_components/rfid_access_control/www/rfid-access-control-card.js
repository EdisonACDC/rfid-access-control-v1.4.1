class RFIDAccessControlCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.users = [];
    this.currentView = 'list';
    this.editingUser = null;
    this.wizardStep = 1;
    this.wizardData = {};
    this.entityFilter = '';
    this.listeningRfid = false;
    this.rfidTimeout = null;
    this.statusMessage = '';
    this.statusType = '';
    this._rendered = false;
    this._eventsBlocked = false;
  }

  connectedCallback() {
    if (!this._eventsBlocked) {
      this._eventsBlocked = true;
      ['keydown', 'keyup', 'keypress', 'input', 'focusin', 'focusout'].forEach(evt => {
        this.addEventListener(evt, (e) => e.stopPropagation());
      });
      this.shadowRoot.addEventListener('keydown', (e) => e.stopPropagation());
      this.shadowRoot.addEventListener('keyup', (e) => e.stopPropagation());
      this.shadowRoot.addEventListener('keypress', (e) => e.stopPropagation());
    }
  }

  setConfig(config) {
    this.config = {
      entity: config.entity || null,
      title: config.title || 'Controllo Accessi RFID',
    };
    this._rendered = false;
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this.listeningRfid) {
      this._checkRfidEvents();
    }
    this._loadUsersFromSensor();
    if (this.currentView !== 'list') {
      return;
    }
    this.render();
  }

  _loadUsersFromSensor() {
    if (!this._hass || !this._hass.states) return;
    const states = this._hass.states;
    for (const entityId of Object.keys(states)) {
      if (entityId.startsWith('sensor.rfid_users_') || entityId.startsWith('sensor.rfid_access_control_')) {
        const state = states[entityId];
        if (state && state.attributes && state.attributes.users) {
          this.users = state.attributes.users;
          return;
        }
      }
    }
  }

  _getEntities() {
    if (!this._hass || !this._hass.states) return [];
    return Object.keys(this._hass.states).sort();
  }

  _getEntityDomains() {
    const domains = new Set();
    this._getEntities().forEach(e => domains.add(e.split('.')[0]));
    return Array.from(domains).sort();
  }

  _getServicesForDomain(domain) {
    if (!this._hass || !this._hass.services || !this._hass.services[domain]) return [];
    return Object.keys(this._hass.services[domain]).sort();
  }

  _getFilteredEntities() {
    const filter = this.entityFilter.toLowerCase();
    return this._getEntities().filter(e => e.toLowerCase().includes(filter));
  }

  _getEntityFriendlyName(entityId) {
    if (!this._hass || !this._hass.states[entityId]) return entityId;
    return this._hass.states[entityId].attributes.friendly_name || entityId;
  }

  _showStatus(message, type) {
    this.statusMessage = message;
    this.statusType = type;
    this.render();
    setTimeout(() => {
      this.statusMessage = '';
      this.statusType = '';
      this.render();
    }, 4000);
  }

  _startRfidListen() {
    this.listeningRfid = true;
    this._rfidListenStart = Date.now() / 1000;
    this._showStatus('Avvicina la tessera RFID al lettore...', 'info');

    this._rfidPollInterval = setInterval(() => {
      this._pollRfidFromSensor();
    }, 1000);

    this.rfidTimeout = setTimeout(() => {
      this._stopRfidListen();
      this._showStatus('Timeout: nessuna tessera rilevata', 'error');
    }, 30000);
    this.render();
  }

  _pollRfidFromSensor() {
    if (!this.listeningRfid || !this._hass || !this._hass.states) return;
    const states = this._hass.states;
    for (const entityId of Object.keys(states)) {
      if (entityId.startsWith('sensor.rfid_users_') || entityId.startsWith('sensor.rfid_access_control_')) {
        const state = states[entityId];
        if (state && state.attributes) {
          const lastCode = state.attributes.last_code;
          const lastTime = state.attributes.last_code_time;
          if (lastCode && lastTime && lastTime > this._rfidListenStart) {
            this.wizardData.rfid = lastCode;
            const rfidInput = this.shadowRoot.getElementById('wizard-rfid');
            if (rfidInput) {
              rfidInput.value = lastCode;
            }
            this._stopRfidListen();
            this._showStatus(`RFID catturato: ${lastCode}`, 'success');
            return;
          }
        }
      }
    }
  }

  _stopRfidListen() {
    this.listeningRfid = false;
    if (this.rfidTimeout) {
      clearTimeout(this.rfidTimeout);
      this.rfidTimeout = null;
    }
    if (this._rfidPollInterval) {
      clearInterval(this._rfidPollInterval);
      this._rfidPollInterval = null;
    }
    this.render();
  }

  _checkRfidEvents() {
    if (this.listeningRfid) {
      this._pollRfidFromSensor();
    }
  }

  _startWizard() {
    this.currentView = 'wizard';
    this.wizardStep = 1;
    this.wizardData = {
      userName: '',
      pin: '',
      rfid: '',
      actions: [],
    };
    this.entityFilter = '';
    this.render();
  }

  _editUser(userId) {
    const user = this.users.find(u => u.user_id === userId);
    if (!user) return;
    this.editingUser = user;
    this.currentView = 'edit';
    this.entityFilter = '';
    this.render();
  }

  _backToList() {
    this.currentView = 'list';
    this.editingUser = null;
    this.wizardData = {};
    this.wizardStep = 1;
    this.entityFilter = '';
    this._stopRfidListen();
    this.render();
  }

  async _submitNewUser() {
    const data = this.wizardData;
    if (!data.userName) {
      this._showStatus('Inserisci il nome utente', 'error');
      return;
    }
    if (!data.pin && !data.rfid) {
      this._showStatus('Inserisci almeno un PIN o RFID', 'error');
      return;
    }

    const userId = data.userName.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now().toString(36);

    try {
      await this._hass.callService('rfid_access_control', 'add_user', {
        user_id: userId,
        user_name: data.userName,
        user_pin: data.pin || '',
        user_rfid: data.rfid || '',
      });

      for (const action of data.actions) {
        await this._hass.callService('rfid_access_control', 'add_action', {
          user_id: userId,
          action_name: action.name,
          action_entity: action.entity_id,
          action_service: action.service,
          action_data: action.service_data || {},
        });
      }

      this._showStatus(`Utente "${data.userName}" creato con successo!`, 'success');
      this._backToList();
    } catch (error) {
      this._showStatus(`Errore: ${error.message}`, 'error');
    }
  }

  async _deleteUser(userId) {
    if (!confirm('Sei sicuro di voler eliminare questo utente?')) return;
    try {
      await this._hass.callService('rfid_access_control', 'remove_user', {
        user_id: userId,
      });
      this.users = this.users.filter(u => u.user_id !== userId);
      if (this.editingUser && this.editingUser.user_id === userId) {
        this._backToList();
      }
      this._showStatus('Utente eliminato', 'success');
    } catch (error) {
      this._showStatus(`Errore: ${error.message}`, 'error');
    }
  }

  async _addActionToUser(userId, actionData) {
    try {
      await this._hass.callService('rfid_access_control', 'add_action', {
        user_id: userId,
        action_name: actionData.name,
        action_entity: actionData.entity_id,
        action_service: actionData.service,
        action_data: actionData.service_data || {},
      });
      this._showStatus('Azione aggiunta!', 'success');
    } catch (error) {
      this._showStatus(`Errore: ${error.message}`, 'error');
    }
  }

  async _removeActionFromUser(userId, actionName) {
    try {
      await this._hass.callService('rfid_access_control', 'remove_action', {
        user_id: userId,
        action_name: actionName,
      });
      this._showStatus('Azione rimossa!', 'success');
    } catch (error) {
      this._showStatus(`Errore: ${error.message}`, 'error');
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const filteredEntities = this._getFilteredEntities().slice(0, 50);

    let selectedDomain = '';
    if (this.currentView === 'wizard' && this.wizardStep === 3) {
      const selEntity = this.shadowRoot.getElementById('wizard-entity');
      if (selEntity && selEntity.value) {
        selectedDomain = selEntity.value.split('.')[0];
      }
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--ha-card-font-family, 'Roboto', sans-serif);
        }
        ha-card, .ha-card {
          background: var(--ha-card-background, var(--card-background-color, white));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
          padding: 20px;
          color: var(--primary-text-color, #212121);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          gap: 8px;
          flex-wrap: wrap;
        }
        .header h2 {
          margin: 0;
          font-size: 20px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 10px 18px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: opacity 0.2s;
          color: white;
        }
        .btn:hover { opacity: 0.85; }
        .btn-primary { background: #03a9f4; }
        .btn-danger { background: #f44336; }
        .btn-success { background: #4caf50; }
        .btn-secondary { background: #9e9e9e; }
        .btn-orange { background: #ff9800; }
        .btn-small {
          padding: 6px 12px;
          font-size: 12px;
        }
        .btn-outline {
          background: transparent;
          border: 2px solid #03a9f4;
          color: #03a9f4;
        }
        .btn-outline:hover {
          background: #03a9f4;
          color: white;
        }
        .btn-group {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .form-group {
          margin-bottom: 16px;
        }
        .form-group label {
          display: block;
          margin-bottom: 6px;
          font-weight: 500;
          font-size: 14px;
          color: var(--secondary-text-color, #757575);
        }
        .form-group input,
        .form-group select,
        .form-group textarea {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          font-size: 14px;
          box-sizing: border-box;
          background: var(--card-background-color, white);
          color: var(--primary-text-color, #212121);
        }
        .form-group input:focus,
        .form-group select:focus {
          outline: none;
          border-color: #03a9f4;
          box-shadow: 0 0 0 2px rgba(3,169,244,0.2);
        }
        .user-card {
          background: var(--secondary-background-color, #f5f5f5);
          border-radius: 10px;
          padding: 16px;
          margin-bottom: 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .user-info { flex: 1; min-width: 200px; }
        .user-info h3 {
          margin: 0 0 4px 0;
          font-size: 16px;
          font-weight: 500;
        }
        .user-info p {
          margin: 2px 0;
          font-size: 13px;
          color: var(--secondary-text-color, #757575);
        }
        .badge {
          display: inline-block;
          padding: 3px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          margin-top: 4px;
        }
        .badge-green { background: #e8f5e9; color: #2e7d32; }
        .badge-red { background: #ffebee; color: #c62828; }
        .badge-blue { background: #e3f2fd; color: #1565c0; }
        .empty-state {
          text-align: center;
          padding: 40px 20px;
          color: var(--secondary-text-color, #757575);
        }
        .empty-state p { margin: 8px 0; font-size: 15px; }
        .wizard-steps {
          display: flex;
          gap: 0;
          margin-bottom: 24px;
        }
        .wizard-step {
          flex: 1;
          text-align: center;
          padding: 10px 4px;
          font-size: 13px;
          font-weight: 500;
          color: var(--secondary-text-color, #9e9e9e);
          border-bottom: 3px solid var(--divider-color, #e0e0e0);
          transition: all 0.2s;
        }
        .wizard-step.active {
          color: #03a9f4;
          border-bottom-color: #03a9f4;
        }
        .wizard-step.done {
          color: #4caf50;
          border-bottom-color: #4caf50;
        }
        .wizard-nav {
          display: flex;
          justify-content: space-between;
          margin-top: 20px;
          gap: 8px;
        }
        .status-msg {
          padding: 10px 16px;
          border-radius: 8px;
          margin-bottom: 16px;
          font-size: 14px;
          font-weight: 500;
        }
        .status-success { background: #e8f5e9; color: #2e7d32; }
        .status-error { background: #ffebee; color: #c62828; }
        .status-info { background: #e3f2fd; color: #1565c0; }
        .rfid-listen {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          background: #e3f2fd;
          border-radius: 8px;
          margin-top: 8px;
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        .rfid-listen .dot {
          width: 12px;
          height: 12px;
          background: #03a9f4;
          border-radius: 50%;
        }
        .action-item {
          background: var(--card-background-color, white);
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 8px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .action-item strong { font-size: 14px; }
        .action-item p {
          margin: 2px 0;
          font-size: 12px;
          color: var(--secondary-text-color, #757575);
        }
        .divider {
          border: none;
          border-top: 1px solid var(--divider-color, #e0e0e0);
          margin: 16px 0;
        }
        .section-title {
          font-size: 16px;
          font-weight: 500;
          margin: 16px 0 12px 0;
        }
        .entity-select-area {
          max-height: 200px;
          overflow-y: auto;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          margin-top: 4px;
        }
        .entity-option {
          padding: 8px 12px;
          cursor: pointer;
          font-size: 13px;
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .entity-option:last-child { border-bottom: none; }
        .entity-option:hover { background: var(--secondary-background-color, #f5f5f5); }
        .entity-option.selected { background: #e3f2fd; }
        .entity-option .name { font-weight: 500; }
        .entity-option .id { color: var(--secondary-text-color, #9e9e9e); font-size: 11px; }
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        @media (max-width: 500px) {
          .form-row { grid-template-columns: 1fr; }
          .user-card { flex-direction: column; align-items: flex-start; }
        }
      </style>

      <div class="ha-card">
        ${this.statusMessage ? `<div class="status-msg status-${this.statusType}">${this.statusMessage}</div>` : ''}

        ${this.currentView === 'list' ? this._renderListView() : ''}
        ${this.currentView === 'wizard' ? this._renderWizardView(filteredEntities) : ''}
        ${this.currentView === 'edit' ? this._renderEditView(filteredEntities) : ''}
      </div>
    `;

    this._attachEvents();
  }

  _renderListView() {
    return `
      <div class="header">
        <h2>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM9 8V6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9z"/></svg>
          ${this.config.title}
        </h2>
        <button class="btn btn-primary" id="btn-add-user">+ Nuovo Utente</button>
      </div>

      ${this.users.length > 0 ? this.users.map(user => `
        <div class="user-card">
          <div class="user-info">
            <h3>${user.user_name}</h3>
            <p>PIN: ${(user.has_pin || user.pin) ? '****' : 'Non impostato'} | RFID: ${(user.has_rfid || user.rfid) ? (user.rfid ? user.rfid.substring(0, 6) + '...' : 'Impostato') : 'Non impostato'}</p>
            <p>Accessi: ${user.access_count || 0} | Ultimo: ${user.last_access ? new Date(user.last_access).toLocaleDateString('it-IT') : 'Mai'}</p>
            <p>Azioni: ${user.actions ? user.actions.length : 0}</p>
            <span class="badge ${user.enabled !== false ? 'badge-green' : 'badge-red'}">
              ${user.enabled !== false ? 'Attivo' : 'Disattivato'}
            </span>
          </div>
          <div class="btn-group">
            <button class="btn btn-primary btn-small btn-edit-user" data-user-id="${user.user_id}">Modifica</button>
            <button class="btn btn-danger btn-small btn-delete-user" data-user-id="${user.user_id}">Elimina</button>
          </div>
        </div>
      `).join('') : `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" opacity="0.3"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          <p>Nessun utente registrato</p>
          <p style="font-size: 13px;">Clicca "Nuovo Utente" per aggiungere il primo utente</p>
        </div>
      `}
    `;
  }

  _renderWizardView(filteredEntities) {
    const steps = ['Utente', 'Credenziali', 'Azioni', 'Riepilogo'];

    return `
      <div class="header">
        <h2>Nuovo Utente</h2>
        <button class="btn btn-secondary btn-small" id="btn-back-list">Annulla</button>
      </div>

      <div class="wizard-steps">
        ${steps.map((s, i) => `
          <div class="wizard-step ${this.wizardStep === i + 1 ? 'active' : ''} ${this.wizardStep > i + 1 ? 'done' : ''}">
            ${i + 1}. ${s}
          </div>
        `).join('')}
      </div>

      ${this.wizardStep === 1 ? this._renderWizardStep1() : ''}
      ${this.wizardStep === 2 ? this._renderWizardStep2() : ''}
      ${this.wizardStep === 3 ? this._renderWizardStep3(filteredEntities) : ''}
      ${this.wizardStep === 4 ? this._renderWizardStep4() : ''}
    `;
  }

  _renderWizardStep1() {
    return `
      <div class="form-group">
        <label>Nome Utente *</label>
        <input type="text" id="wizard-name" placeholder="Es: Mario Rossi" value="${this.wizardData.userName || ''}" />
      </div>
      <div class="wizard-nav">
        <div></div>
        <button class="btn btn-primary" id="btn-wizard-next-1">Avanti</button>
      </div>
    `;
  }

  _renderWizardStep2() {
    return `
      <div class="form-group">
        <label>PIN (4-8 cifre)</label>
        <input type="password" id="wizard-pin" placeholder="Es: 1234" maxlength="8" value="${this.wizardData.pin || ''}" />
      </div>

      <div class="form-group">
        <label>Codice RFID</label>
        <div class="form-row">
          <input type="text" id="wizard-rfid" placeholder="Es: 04A12B3C" value="${this.wizardData.rfid || ''}" />
          <button class="btn btn-orange btn-small" id="btn-listen-rfid" ${this.listeningRfid ? 'disabled' : ''}>
            ${this.listeningRfid ? 'In ascolto...' : 'Leggi RFID'}
          </button>
        </div>
        ${this.listeningRfid ? `
          <div class="rfid-listen">
            <div class="dot"></div>
            <span>In ascolto... avvicina la tessera al lettore</span>
            <button class="btn btn-secondary btn-small" id="btn-stop-rfid">Stop</button>
          </div>
        ` : ''}
      </div>

      <div class="wizard-nav">
        <button class="btn btn-secondary" id="btn-wizard-prev-2">Indietro</button>
        <button class="btn btn-primary" id="btn-wizard-next-2">Avanti</button>
      </div>
    `;
  }

  _renderWizardStep3(filteredEntities) {
    const pendingActions = this.wizardData.actions || [];

    return `
      <p class="section-title">Aggiungi Azioni da Eseguire all'Accesso</p>

      <div class="form-group">
        <label>Cerca Entita</label>
        <input type="text" id="wizard-entity-filter" placeholder="Cerca entita... (es: light, switch, cover)" value="${this.entityFilter}" />
      </div>

      <div class="form-group">
        <label>Seleziona Entita</label>
        <select id="wizard-entity">
          <option value="">-- Scegli entita --</option>
          ${filteredEntities.map(e => `
            <option value="${e}">${this._getEntityFriendlyName(e)} (${e})</option>
          `).join('')}
        </select>
      </div>

      <div class="form-group" id="service-group" style="display:none;">
        <label>Servizio</label>
        <select id="wizard-service">
          <option value="">-- Scegli servizio --</option>
        </select>
      </div>

      <div class="form-group" id="action-name-group" style="display:none;">
        <label>Nome Azione (descrizione)</label>
        <input type="text" id="wizard-action-name" placeholder="Es: Accendi luce ingresso" />
      </div>

      <button class="btn btn-success btn-small" id="btn-add-action" style="display:none;">+ Aggiungi Azione</button>

      ${pendingActions.length > 0 ? `
        <hr class="divider" />
        <p class="section-title">Azioni Configurate (${pendingActions.length})</p>
        ${pendingActions.map((action, idx) => `
          <div class="action-item">
            <div>
              <strong>${action.name}</strong>
              <p>${action.service} → ${action.entity_id}</p>
            </div>
            <button class="btn btn-danger btn-small btn-remove-pending-action" data-idx="${idx}">Rimuovi</button>
          </div>
        `).join('')}
      ` : ''}

      <div class="wizard-nav">
        <button class="btn btn-secondary" id="btn-wizard-prev-3">Indietro</button>
        <button class="btn btn-primary" id="btn-wizard-next-3">
          ${pendingActions.length > 0 ? 'Avanti' : 'Salta (nessuna azione)'}
        </button>
      </div>
    `;
  }

  _renderWizardStep4() {
    const data = this.wizardData;
    return `
      <p class="section-title">Riepilogo Nuovo Utente</p>

      <div class="user-card">
        <div class="user-info">
          <h3>${data.userName}</h3>
          <p>PIN: ${data.pin ? '****' : 'Non impostato'}</p>
          <p>RFID: ${data.rfid || 'Non impostato'}</p>
          <p>Azioni: ${data.actions.length}</p>
        </div>
      </div>

      ${data.actions.length > 0 ? `
        <p class="section-title">Azioni:</p>
        ${data.actions.map(a => `
          <div class="action-item">
            <div>
              <strong>${a.name}</strong>
              <p>${a.service} → ${a.entity_id}</p>
            </div>
          </div>
        `).join('')}
      ` : ''}

      <div class="wizard-nav">
        <button class="btn btn-secondary" id="btn-wizard-prev-4">Indietro</button>
        <button class="btn btn-success" id="btn-wizard-confirm">Crea Utente</button>
      </div>
    `;
  }

  _renderEditView(filteredEntities) {
    const user = this.editingUser;
    if (!user) return '';

    return `
      <div class="header">
        <h2>Modifica: ${user.user_name}</h2>
        <div class="btn-group">
          <button class="btn btn-secondary btn-small" id="btn-back-list">Indietro</button>
          <button class="btn btn-danger btn-small" id="btn-delete-editing-user">Elimina Utente</button>
        </div>
      </div>

      <div class="form-group">
        <label>Nome Utente</label>
        <input type="text" id="edit-name" value="${user.user_name}" />
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>PIN</label>
          <input type="password" id="edit-pin" value="${user.pin || ''}" placeholder="Lascia vuoto per non cambiare" />
        </div>
        <div class="form-group">
          <label>RFID</label>
          <div style="display:flex; gap:6px;">
            <input type="text" id="edit-rfid" value="${user.rfid || ''}" placeholder="Codice RFID" style="flex:1;" />
            <button class="btn btn-orange btn-small" id="btn-edit-listen-rfid">Leggi</button>
          </div>
        </div>
      </div>

      <button class="btn btn-primary btn-small" id="btn-save-user">Salva Modifiche</button>

      <hr class="divider" />

      <p class="section-title">Azioni Utente (${user.actions ? user.actions.length : 0})</p>

      ${user.actions && user.actions.length > 0 ? user.actions.map((action, idx) => `
        <div class="action-item">
          <div>
            <strong>${action.action_name || action.name || 'Azione'}</strong>
            <p>${action.service} → ${action.entity_id}</p>
          </div>
          <button class="btn btn-danger btn-small btn-remove-user-action" data-action-name="${action.action_name || action.name || ''}">Rimuovi</button>
        </div>
      `).join('') : '<p style="color: var(--secondary-text-color);">Nessuna azione configurata</p>'}

      <hr class="divider" />
      <p class="section-title">Aggiungi Nuova Azione</p>

      <div class="form-group">
        <label>Cerca Entita</label>
        <input type="text" id="edit-entity-filter" placeholder="Cerca..." value="${this.entityFilter}" />
      </div>

      <div class="form-group">
        <label>Entita</label>
        <select id="edit-entity">
          <option value="">-- Scegli entita --</option>
          ${filteredEntities.map(e => `
            <option value="${e}">${this._getEntityFriendlyName(e)} (${e})</option>
          `).join('')}
        </select>
      </div>

      <div class="form-group" id="edit-service-group" style="display:none;">
        <label>Servizio</label>
        <select id="edit-service">
          <option value="">-- Scegli servizio --</option>
        </select>
      </div>

      <div class="form-group" id="edit-action-name-group" style="display:none;">
        <label>Nome Azione</label>
        <input type="text" id="edit-action-name" placeholder="Es: Apri portone" />
      </div>

      <button class="btn btn-success btn-small" id="btn-add-edit-action" style="display:none;">+ Aggiungi Azione</button>
    `;
  }

  _attachEvents() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const $$ = (sel) => this.shadowRoot.querySelectorAll(sel);

    // List view
    if ($('btn-add-user')) {
      $('btn-add-user').addEventListener('click', () => this._startWizard());
    }

    $$('.btn-edit-user').forEach(btn => {
      btn.addEventListener('click', (e) => this._editUser(e.target.dataset.userId));
    });

    $$('.btn-delete-user').forEach(btn => {
      btn.addEventListener('click', (e) => this._deleteUser(e.target.dataset.userId));
    });

    // Back to list
    if ($('btn-back-list')) {
      $('btn-back-list').addEventListener('click', () => this._backToList());
    }

    // Wizard step 1
    if ($('btn-wizard-next-1')) {
      $('btn-wizard-next-1').addEventListener('click', () => {
        const name = $('wizard-name')?.value?.trim();
        if (!name) { this._showStatus('Inserisci il nome utente', 'error'); return; }
        this.wizardData.userName = name;
        this.wizardStep = 2;
        this.render();
      });
    }

    // Wizard step 2
    if ($('btn-wizard-prev-2')) {
      $('btn-wizard-prev-2').addEventListener('click', () => { this.wizardStep = 1; this.render(); });
    }
    if ($('btn-wizard-next-2')) {
      $('btn-wizard-next-2').addEventListener('click', () => {
        this.wizardData.pin = $('wizard-pin')?.value || '';
        this.wizardData.rfid = $('wizard-rfid')?.value || '';
        if (!this.wizardData.pin && !this.wizardData.rfid) {
          this._showStatus('Inserisci almeno un PIN o un codice RFID', 'error');
          return;
        }
        this._stopRfidListen();
        this.wizardStep = 3;
        this.render();
      });
    }
    if ($('btn-listen-rfid')) {
      $('btn-listen-rfid').addEventListener('click', () => this._startRfidListen());
    }
    if ($('btn-stop-rfid')) {
      $('btn-stop-rfid').addEventListener('click', () => this._stopRfidListen());
    }

    // Wizard step 3 - entity filter
    if ($('wizard-entity-filter')) {
      $('wizard-entity-filter').addEventListener('input', (e) => {
        this.entityFilter = e.target.value;
        this.render();
      });
    }

    // Entity select → show services
    if ($('wizard-entity')) {
      $('wizard-entity').addEventListener('change', (e) => {
        const entityId = e.target.value;
        if (entityId) {
          const domain = entityId.split('.')[0];
          const services = this._getServicesForDomain(domain);
          const serviceGroup = $('service-group');
          const serviceSelect = $('wizard-service');
          const actionNameGroup = $('action-name-group');
          const addBtn = $('btn-add-action');

          if (serviceGroup) serviceGroup.style.display = 'block';
          if (actionNameGroup) actionNameGroup.style.display = 'block';
          if (addBtn) addBtn.style.display = 'inline-flex';

          if (serviceSelect) {
            serviceSelect.innerHTML = '<option value="">-- Scegli servizio --</option>' +
              services.map(s => `<option value="${domain}.${s}">${s}</option>`).join('');
          }
        }
      });
    }

    // Add action in wizard
    if ($('btn-add-action')) {
      $('btn-add-action').addEventListener('click', () => {
        const entityId = $('wizard-entity')?.value;
        const service = $('wizard-service')?.value;
        const actionName = $('wizard-action-name')?.value?.trim();

        if (!entityId || !service) {
          this._showStatus('Seleziona entita e servizio', 'error');
          return;
        }

        this.wizardData.actions.push({
          entity_id: entityId,
          service: service,
          name: actionName || `${service} → ${entityId}`,
          service_data: {},
        });

        this.entityFilter = '';
        this.render();
      });
    }

    // Remove pending action
    $$('.btn-remove-pending-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        this.wizardData.actions.splice(idx, 1);
        this.render();
      });
    });

    // Wizard step 3 nav
    if ($('btn-wizard-prev-3')) {
      $('btn-wizard-prev-3').addEventListener('click', () => { this.wizardStep = 2; this.render(); });
    }
    if ($('btn-wizard-next-3')) {
      $('btn-wizard-next-3').addEventListener('click', () => { this.wizardStep = 4; this.render(); });
    }

    // Wizard step 4
    if ($('btn-wizard-prev-4')) {
      $('btn-wizard-prev-4').addEventListener('click', () => { this.wizardStep = 3; this.render(); });
    }
    if ($('btn-wizard-confirm')) {
      $('btn-wizard-confirm').addEventListener('click', () => this._submitNewUser());
    }

    // Edit view
    if ($('btn-delete-editing-user')) {
      $('btn-delete-editing-user').addEventListener('click', () => {
        if (this.editingUser) this._deleteUser(this.editingUser.user_id);
      });
    }

    if ($('btn-save-user')) {
      $('btn-save-user').addEventListener('click', async () => {
        if (!this.editingUser) return;
        const newName = $('edit-name')?.value?.trim();
        const newPin = $('edit-pin')?.value;
        const newRfid = $('edit-rfid')?.value;

        try {
          await this._hass.callService('rfid_access_control', 'update_user', {
            user_id: this.editingUser.user_id,
            user_name: newName || this.editingUser.user_name,
            pin: newPin || this.editingUser.pin,
            rfid: newRfid || this.editingUser.rfid,
          });
          this._showStatus('Utente aggiornato!', 'success');
        } catch (error) {
          this._showStatus(`Errore: ${error.message}`, 'error');
        }
      });
    }

    if ($('btn-edit-listen-rfid')) {
      $('btn-edit-listen-rfid').addEventListener('click', () => this._startRfidListen());
    }

    // Edit entity filter
    if ($('edit-entity-filter')) {
      $('edit-entity-filter').addEventListener('input', (e) => {
        this.entityFilter = e.target.value;
        this.render();
      });
    }

    // Edit entity select → services
    if ($('edit-entity')) {
      $('edit-entity').addEventListener('change', (e) => {
        const entityId = e.target.value;
        if (entityId) {
          const domain = entityId.split('.')[0];
          const services = this._getServicesForDomain(domain);
          const sg = $('edit-service-group');
          const ss = $('edit-service');
          const ang = $('edit-action-name-group');
          const ab = $('btn-add-edit-action');

          if (sg) sg.style.display = 'block';
          if (ang) ang.style.display = 'block';
          if (ab) ab.style.display = 'inline-flex';

          if (ss) {
            ss.innerHTML = '<option value="">-- Scegli servizio --</option>' +
              services.map(s => `<option value="${domain}.${s}">${s}</option>`).join('');
          }
        }
      });
    }

    // Add action to existing user
    if ($('btn-add-edit-action')) {
      $('btn-add-edit-action').addEventListener('click', async () => {
        if (!this.editingUser) return;
        const entityId = $('edit-entity')?.value;
        const service = $('edit-service')?.value;
        const actionName = $('edit-action-name')?.value?.trim();

        if (!entityId || !service) {
          this._showStatus('Seleziona entita e servizio', 'error');
          return;
        }

        await this._addActionToUser(this.editingUser.user_id, {
          entity_id: entityId,
          service: service,
          name: actionName || `${service} → ${entityId}`,
        });
      });
    }

    // Remove action from user
    $$('.btn-remove-user-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (!this.editingUser) return;
        const actionName = e.target.dataset.actionName;
        await this._removeActionFromUser(this.editingUser.user_id, actionName);
      });
    });
  }

  getCardSize() {
    return 5;
  }
}

customElements.define('rfid-access-control-card', RFIDAccessControlCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'rfid-access-control-card',
  name: 'RFID Access Control Card',
  description: 'Gestisci utenti, PIN, RFID e azioni di controllo accessi',
  preview: true,
});
