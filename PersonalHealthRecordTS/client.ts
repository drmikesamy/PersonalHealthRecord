// Types for Nostr and FHIR
interface NostrKeys {
    private: Uint8Array;
    public: string;
    npub: string;
    nsec: string;
}

interface HealthRecord {
    id: string;
    category: string;
    timestamp: string;
    data: FHIRBundle;
}

interface FHIRBundle {
    resourceType: 'Bundle';
    type: 'collection';
    entry: Array<{ resource: any }>;
}

interface FHIRObservation {
    resourceType: 'Observation';
    id: string;
    status: 'final';
    category: Array<{ coding: Array<{ system: string; code: string }> }>;
    code: { coding: Array<{ system: string; code: string; display: string }> };
    subject: { reference: string };
    effectiveDateTime: string;
    valueQuantity?: { value: number; unit: string; system: string };
    valueString?: string;
    note?: Array<{ text: string }>;
}

declare global {
    interface Window {
        NostrTools: any;
        healthRecord: PersonalHealthRecord;
    }
}

class PersonalHealthRecord {
    private nostrKeys: NostrKeys | null = null;
    private relayPool: any = null;
    private connectedRelays: string[] = [];
    private healthRecords: HealthRecord[] = [];
    private patientId: string | null = null;

    private readonly nostrRelays = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band',
        'wss://nostr-pub.wellorder.net',
    ];

    constructor() {
        this.log('🏥 Personal Health Record system initialized (HTMX + TypeScript)');
        this.initializeSystem();
    }

    private async initializeSystem(): Promise<void> {
        try {
            await this.generateKeys();
            await this.connectToRelays();
            await this.loadHealthRecords();
            this.updateTimeline();
        } catch (error) {
            this.log(`❌ Initialization error: ${error}`);
        }
    }

    private log(message: string): void {
        console.log(message);
        const debugInfo = document.getElementById('debugInfo');
        if (debugInfo) {
            debugInfo.innerHTML += `<br>[${new Date().toLocaleTimeString()}] ${message}`;
            debugInfo.scrollTop = debugInfo.scrollHeight;
        }
    }

    private async generateKeys(): Promise<NostrKeys | null> {
        try {
            const privateKey = window.NostrTools.generateSecretKey();
            const publicKey = window.NostrTools.getPublicKey(privateKey);

            this.nostrKeys = {
                private: privateKey,
                public: publicKey,
                npub: window.NostrTools.nip19.npubEncode(publicKey),
                nsec: window.NostrTools.nip19.nsecEncode(privateKey)
            };

            this.patientId = `patient-${publicKey.substring(0, 16)}`;
            this.log(`🔑 Generated new health identity: ${this.nostrKeys.npub}`);

            const publicKeyDisplay = document.getElementById('publicKeyDisplay');
            if (publicKeyDisplay) {
                publicKeyDisplay.textContent = this.nostrKeys.npub;
            }

            this.updateConnectionStatus();
            return this.nostrKeys;
        } catch (error) {
            this.log(`❌ Error generating keys: ${error}`);
            return null;
        }
    }

    private async connectToRelays(): Promise<void> {
        if (!this.nostrKeys) {
            this.log('❌ Generate identity first');
            return;
        }

        try {
            this.log('🔌 Connecting to Nostr relays...');
            this.relayPool = new window.NostrTools.SimplePool();
            this.connectedRelays = [];

            const promises = this.nostrRelays.map(async (url) => {
                try {
                    await this.relayPool.ensureRelay(url);
                    this.connectedRelays.push(url);
                    this.log(`✅ Connected to ${url}`);
                } catch (err) {
                    this.log(`⚠️ Failed to connect to ${url}`);
                }
            });

            await Promise.all(promises);

            if (this.connectedRelays.length === 0) {
                throw new Error('Failed to connect to any relays');
            }

            this.log(`🎉 Connected to ${this.connectedRelays.length} relays`);
            this.updateConnectionStatus();

        } catch (error) {
            this.log(`❌ Error connecting to relays: ${error}`);
        }
    }

    private updateConnectionStatus(): void {
        const statusElement = document.getElementById('connectionStatus');
        if (!statusElement) return;

        if (this.connectedRelays.length > 0 && this.nostrKeys) {
            statusElement.textContent = `🟢 Connected (${this.connectedRelays.length} Relays)`;
            statusElement.className = 'status connected';
        } else if (this.nostrKeys) {
            statusElement.textContent = '🟡 Connecting...';
            statusElement.className = 'status connecting';
        } else {
            statusElement.textContent = '🔴 No Identity';
            statusElement.className = 'status disconnected';
        }
    }

    public createFHIRObservation(
        category: string,
        code: { code: string; display: string },
        value: string | null,
        unit: string | null,
        notes: string = ''
    ): FHIRObservation {
        const resource: FHIRObservation = {
            resourceType: "Observation",
            id: `obs-${Date.now()}`,
            status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: category }] }],
            code: { coding: [{ system: "http://loinc.org", code: code.code, display: code.display }] },
            subject: { reference: `Patient/${this.patientId}` },
            effectiveDateTime: new Date().toISOString(),
        };

        if (value !== null && unit) {
            resource.valueQuantity = { 
                value: parseFloat(value), 
                unit: unit, 
                system: "http://unitsofmeasure.org" 
            };
        } else if (value !== null) {
            resource.valueString = value;
        }

        if (notes) {
            resource.note = [{ text: notes }];
        }

        return resource;
    }

    public async storeHealthData(fhirBundle: FHIRBundle, category: string): Promise<void> {
        if (!this.nostrKeys) {
            throw new Error('No health identity available');
        }

        try {
            this.log(`Encrypting ${category} data...`);
            const encryptedData = await window.NostrTools.nip04.encrypt(
                this.nostrKeys.private, 
                this.nostrKeys.public, 
                JSON.stringify(fhirBundle)
            );

            const event = window.NostrTools.finalizeEvent({
                kind: 31000,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['d', `${category}-${Date.now()}`], 
                    ['t', 'health-record'], 
                    ['t', category]
                ],
                content: encryptedData,
            }, this.nostrKeys.private);

            this.healthRecords.push({
                id: event.id,
                category,
                timestamp: new Date(event.created_at * 1000).toISOString(),
                data: fhirBundle
            });

            if (this.connectedRelays.length > 0) {
                await this.relayPool.publish(this.connectedRelays, event);
                this.log(`📡 Event for ${category} published to ${this.connectedRelays.length} relays`);
            }
        } catch (error) {
            this.log(`❌ Error storing health data: ${error}`);
            throw error;
        }
    }

    private async loadHealthRecords(): Promise<void> {
        if (!this.nostrKeys) {
            this.log('❌ No identity to load records for');
            return;
        }

        this.log('🔍 Loading encrypted health records...');

        if (this.connectedRelays.length > 0) {
            try {
                const events = await this.relayPool.querySync(this.connectedRelays, {
                    kinds: [31000],
                    authors: [this.nostrKeys.public],
                    '#t': ['health-record']
                });

                this.log(`📥 Found ${events.length} records on relays`);
                this.healthRecords = [];

                for (const event of events) {
                    try {
                        const decrypted = await window.NostrTools.nip04.decrypt(
                            this.nostrKeys.private, 
                            this.nostrKeys.public, 
                            event.content
                        );
                        const fhirBundle = JSON.parse(decrypted);
                        const category = event.tags.find(t => t[0] === 't' && t[1] !== 'health-record')?.[1] || 'unknown';
                        
                        this.healthRecords.push({
                            id: event.id,
                            category,
                            timestamp: new Date(event.created_at * 1000).toISOString(),
                            data: fhirBundle
                        });
                    } catch (e) {
                        this.log(`⚠️ Could not decrypt event ${event.id.substring(0, 8)}`);
                    }
                }

                this.log(`✅ Decrypted ${this.healthRecords.length} records`);
            } catch (error) {
                this.log(`❌ Error loading records: ${error}`);
            }
        }
    }

    public getHealthRecords(): HealthRecord[] {
        return this.healthRecords;
    }

    public exportKeypair(): void {
        if (!this.nostrKeys) {
            alert('No keypair to export. Generate keys first.');
            return;
        }

        const exportData = {
            keyType: 'Nostr Health Identity',
            patientId: this.patientId,
            npub: this.nostrKeys.npub,
            nsec: this.nostrKeys.nsec,
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');

        a.href = url;
        a.download = `health-identity-${this.patientId}.json`;

        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.log('🔐 Health identity keypair exported');
        }, 100);
    }

    private updateTimeline(): void {
        // Trigger HTMX to refresh timeline
        const timelineElement = document.getElementById('healthTimeline');
        if (timelineElement) {
            window.htmx.trigger(timelineElement, 'refresh');
        }
    }
}

// Global functions for modal management
function openModal(modalId: string): void {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'block';
    }
}

function closeModal(modalId: string): void {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
        const form = modal.querySelector('form');
        if (form) {
            form.reset();
        }
    }
}

// Global click handler for modal backdrop
window.onclick = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains('modal')) {
        closeModal(target.id);
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.healthRecord = new PersonalHealthRecord();
    
    // File import handler
    const importFile = document.getElementById('importFile') as HTMLInputElement;
    if (importFile) {
        importFile.onchange = async (event) => {
            const file = (event.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const data = JSON.parse(text);

                if (!data.nsec) {
                    throw new Error('Invalid key file: The file must contain an "nsec" property.');
                }

                // This would require re-implementing the import logic
                alert('Key import functionality would be implemented here');
                
            } catch (error) {
                alert(`❌ Failed to import keypair:\n${error}`);
            }
        };
    }

    // Export button handler
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            window.healthRecord.exportKeypair();
        });
    }
});

// Make functions globally available
(window as any).openModal = openModal;
(window as any).closeModal = closeModal;
