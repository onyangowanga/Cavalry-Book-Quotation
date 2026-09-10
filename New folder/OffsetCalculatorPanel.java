import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.text.DecimalFormat;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.LinkedList;

/**
 * OffsetCalculatorPanel.java
 * Implements a JPanel for calculating offset printing costs, including optional
 * fixed (overall) and unit (per copy) finishing costs, plus a user-defined profit margin,
 * and features a history mechanism to save and load the last 5 calculations.
 */
public class OffsetCalculatorPanel extends JPanel implements ActionListener {
    
    // Static format for currency/costs
    private static final DecimalFormat DECIMAL_FORMAT = new DecimalFormat("#,##0.00");

    // --- Core UI Components ---
    private final JTextField pagesField = new JTextField(10);
    private final JTextField quantityField = new JTextField(10);
    private final JTextField paperCostField = new JTextField(10); // For "Others" cost (Rim Cost)
    private final JComboBox<String> paperTypeDropdown;
    private final JComboBox<String> paperSizeDropdown;
    private final JComboBox<String> colorsDropdown;
    private final JComboBox<String> sidesDropdown;
    private final JComboBox<String> machineDropdown;
    
    // --- Overall Fixed Costs (Kshs. Lump Sum) ---
    private final JTextField cuttingCostField = new JTextField(10);
    private final JTextField packagingCostField = new JTextField(10);
    private final JTextField otherOverallCostField = new JTextField(10); 
    
    // --- Unit Costs (Kshs. per Copy) ---
    private final JTextField collectionCostField = new JTextField(10);
    private final JTextField bindingCostField = new JTextField(10);
    private final JTextField laminationCostField = new JTextField(10);
    private final JTextField coverCostField = new JTextField(10);
    private final JTextField otherUnitCostField = new JTextField(10); 
    private final JTextField profitMarginUnitCostField = new JTextField(10); 

    // --- History Storage & UI ---
    private final int MAX_HISTORY_SIZE = 5;
    // Stores a list of maps, where each map holds the state of all input fields (as strings).
    private final java.util.List<Map<String, String>> calculationHistory = new LinkedList<>();
    private final JComboBox<String> historyDropdown = new JComboBox<>();
    private final JButton loadHistoryButton = new JButton("LOAD");
    
    // --- Action/Output Components ---
    private final JButton calculateButton = new JButton("CALCULATE");
    private final JTextArea quotationArea = new JTextArea(8, 40);

    // --- Constants & Lookups ---
    private final Map<String, Integer> PAPER_CATALOGUE = new HashMap<>();
    private final Map<String, Integer> SIDES_VALUES = new HashMap<>();
    private final Map<String, Integer> PAPER_SIZES = new HashMap<>();
    private final Map<String, Integer> MACHINES = new HashMap<>();
    private static final int PLATE_COST_PER_UNIT = 250; // Cost per plate unit (Kshs.)
    
    public OffsetCalculatorPanel() {
        // --- Setup Constants (Rim Cost in Kshs. per 500 sheets) ---
        PAPER_CATALOGUE.put("Bond 70", 1100);
        PAPER_CATALOGUE.put("Bond 80", 1300);
        PAPER_CATALOGUE.put("Art 135", 2400);
        PAPER_CATALOGUE.put("Art 150", 2800);
        PAPER_CATALOGUE.put("Art 175", 2800); 
        SIDES_VALUES.put("Single sided", 1);
        SIDES_VALUES.put("Double sided", 2);
        PAPER_SIZES.put("A3", 1);
        PAPER_SIZES.put("A4", 2);
        PAPER_SIZES.put("A5", 4);
        PAPER_SIZES.put("A6", 8);
        MACHINES.put("GTO 46", 250);
        MACHINES.put("SM", 300);

        // --- UI Setup ---
        setLayout(new BorderLayout(15, 15));
        setBorder(new EmptyBorder(20, 20, 20, 20));

        // --- Dropdown Setup ---
        String[] paperTypes = {"Bond 70", "Bond 80", "Art 135", "Art 150", "Art 175", "Others"};
        paperTypeDropdown = new JComboBox<>(paperTypes);
        paperTypeDropdown.addActionListener(e -> togglePaperCostField());
        
        String[] paperSizes = {"A3", "A4", "A5", "A6"};
        paperSizeDropdown = new JComboBox<>(paperSizes);

        String[] colors = {"1", "2", "3", "4"};
        colorsDropdown = new JComboBox<>(colors);

        String[] sides = {"Single sided", "Double sided"};
        sidesDropdown = new JComboBox<>(sides);

        String[] machines = {"GTO 46", "SM"};
        machineDropdown = new JComboBox<>(machines);


        // --- Input Container (Two Columns: Printing & Finishing) ---
        JPanel inputContainer = new JPanel(new GridLayout(1, 2, 20, 0)); 
        
        // Panel 1: Printing Specifications (8 rows)
        JPanel detailsPanel = new JPanel(new GridLayout(8, 2, 10, 10)); 
        detailsPanel.setBorder(BorderFactory.createTitledBorder("Printing & Material Specs"));
        
        detailsPanel.add(new JLabel("Total Pages (e.g., 32):"));
        detailsPanel.add(pagesField);
        detailsPanel.add(new JLabel("Quantity (No. of Copies):"));
        detailsPanel.add(quantityField);
        detailsPanel.add(new JLabel("Printed Paper Size:"));
        detailsPanel.add(paperSizeDropdown);
        detailsPanel.add(new JLabel("No. of Colors:"));
        detailsPanel.add(colorsDropdown);
        detailsPanel.add(new JLabel("Printed Sides:"));
        detailsPanel.add(sidesDropdown);
        detailsPanel.add(new JLabel("Printer Type:"));
        detailsPanel.add(machineDropdown);
        detailsPanel.add(new JLabel("Paper Type:"));
        detailsPanel.add(paperTypeDropdown);
        detailsPanel.add(new JLabel("If 'Others', Rim Cost (Kshs.):"));
        detailsPanel.add(paperCostField);

        paperCostField.setEnabled(false);
        paperCostField.setBackground(Color.LIGHT_GRAY);


        // Panel 2: Other Costs (9 rows for all finishing/profit costs)
        JPanel costsPanel = new JPanel(new GridLayout(9, 2, 10, 10)); 
        costsPanel.setBorder(BorderFactory.createTitledBorder("Optional Finishing & Profit (Kshs.)"));

        // Overall Costs (Lump Sum)
        costsPanel.add(new JLabel("Overall Cost: Cutting:"));
        costsPanel.add(cuttingCostField);
        costsPanel.add(new JLabel("Overall Cost: Packaging:"));
        costsPanel.add(packagingCostField);
        costsPanel.add(new JLabel("Overall Cost: Other Fixed:")); 
        costsPanel.add(otherOverallCostField);
        
        // Unit Costs (Per Copy)
        costsPanel.add(new JLabel("Unit Cost: Collection:"));
        costsPanel.add(collectionCostField);
        costsPanel.add(new JLabel("Unit Cost: Binding:"));
        costsPanel.add(bindingCostField);
        costsPanel.add(new JLabel("Unit Cost: Lamination:"));
        costsPanel.add(laminationCostField);
        costsPanel.add(new JLabel("Unit Cost: Cover Cost:"));
        costsPanel.add(coverCostField);
        costsPanel.add(new JLabel("Unit Cost: Other Variable:")); 
        costsPanel.add(otherUnitCostField);
        costsPanel.add(new JLabel("Unit Cost: Profit Margin:")); 
        costsPanel.add(profitMarginUnitCostField);

        // Add both to the container
        inputContainer.add(detailsPanel);
        inputContainer.add(costsPanel);
        add(inputContainer, BorderLayout.NORTH);


        // --- Calculation & Output ---
        JPanel centerPanel = new JPanel(new BorderLayout(10, 10));
        
        // Panel for Calculate Button and History Controls
        JPanel actionPanel = new JPanel(new BorderLayout());
        
        calculateButton.addActionListener(this);
        calculateButton.setBackground(new Color(60, 179, 113)); 
        calculateButton.setForeground(Color.BLUE);
        calculateButton.setFont(new Font("SansSerif", Font.BOLD, 16));
        actionPanel.add(calculateButton, BorderLayout.NORTH);

        // History Panel
        JPanel historyPanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 10, 5));
        historyPanel.setBorder(BorderFactory.createTitledBorder("Calculation History (Max 5)"));
        
        historyDropdown.setPreferredSize(new Dimension(300, 25)); 
        historyDropdown.setEnabled(false);

        loadHistoryButton.addActionListener(e -> loadCalculation());
        loadHistoryButton.setEnabled(false);

        historyPanel.add(new JLabel("Previous Quotes:"));
        historyPanel.add(historyDropdown);
        historyPanel.add(loadHistoryButton);
        
        actionPanel.add(historyPanel, BorderLayout.CENTER);
        centerPanel.add(actionPanel, BorderLayout.NORTH);

        quotationArea.setEditable(false);
        quotationArea.setFont(new Font("Monospaced", Font.PLAIN, 14));
        quotationArea.setBackground(new Color(240, 248, 255));
        quotationArea.setBorder(BorderFactory.createTitledBorder("Calculation Details & Quote (Kshs.)"));
        centerPanel.add(new JScrollPane(quotationArea), BorderLayout.CENTER);
        
        JButton restartButton = new JButton("Reset All Fields and History");
        restartButton.addActionListener(e -> refreshFields());
        restartButton.setBackground(new Color(150, 150, 150));
        restartButton.setForeground(Color.blue);
        centerPanel.add(restartButton, BorderLayout.SOUTH);

        add(centerPanel, BorderLayout.CENTER);
        
        // Set default values for quick testing
        setDefaultValues();
    }
    
    /**
     * Helper method to safely parse an optional JTextField.
     * Returns 0.0 if the field is empty. Throws NumberFormatException if invalid text is entered.
     */
    private double getOptionalDouble(JTextField field) throws NumberFormatException {
        String text = field.getText().trim();
        if (text.isEmpty()) {
            return 0.0;
        }
        return Double.parseDouble(text);
    }
    
    /**
     * Sets the default inputs for quick testing or demonstration.
     */
    private void setDefaultValues() {
        pagesField.setText("32");
        quantityField.setText("1000");
        paperTypeDropdown.setSelectedItem("Art 135");
        colorsDropdown.setSelectedItem("4");
        sidesDropdown.setSelectedItem("Double sided");
        machineDropdown.setSelectedItem("GTO 46");
        paperSizeDropdown.setSelectedItem("A4");
        
        // Clear all optional costs
        cuttingCostField.setText("");
        packagingCostField.setText("");
        collectionCostField.setText("");
        bindingCostField.setText("");
        laminationCostField.setText("");
        coverCostField.setText("");
        otherOverallCostField.setText("");
        otherUnitCostField.setText("");
        profitMarginUnitCostField.setText("");
        
        togglePaperCostField();
    }
    
    /**
     * Toggles the visibility/usability of the custom paper cost field
     * based on whether "Others" is selected in the dropdown.
     */
    private void togglePaperCostField() {
        boolean enable = "Others".equals(paperTypeDropdown.getSelectedItem());
        paperCostField.setEnabled(enable);
        paperCostField.setBackground(enable ? Color.WHITE : Color.LIGHT_GRAY);
        if (!enable) {
             paperCostField.setText("");
        }
    }

    /**
     * Resets all input fields and dropdowns to their initial state and clears history.
     */
    private void refreshFields() {
        pagesField.setText("");
        quantityField.setText("");
        paperCostField.setText("");
        quotationArea.setText("");
        
        // Reset all optional cost fields
        cuttingCostField.setText("");
        packagingCostField.setText("");
        collectionCostField.setText("");
        bindingCostField.setText("");
        laminationCostField.setText("");
        coverCostField.setText("");
        otherOverallCostField.setText(""); 
        otherUnitCostField.setText("");     
        profitMarginUnitCostField.setText(""); 
        
        paperTypeDropdown.setSelectedIndex(0);
        paperSizeDropdown.setSelectedIndex(0);
        colorsDropdown.setSelectedIndex(0);
        sidesDropdown.setSelectedIndex(0);
        machineDropdown.setSelectedIndex(0);
        togglePaperCostField();
        
        // Clear history
        calculationHistory.clear();
        historyDropdown.removeAllItems();
        historyDropdown.setEnabled(false);
        loadHistoryButton.setEnabled(false);
    }

    @Override
    public void actionPerformed(ActionEvent e) {
        if (e.getSource() == calculateButton) {
            calculateOffsetCost();
        }
    }
    
    /**
     * Executes the core offset printing cost calculation logic.
     */
    private void calculateOffsetCost() {
        try {
            // 1. Get raw core inputs
            int pages = Integer.parseInt(pagesField.getText().trim());
            int qty = Integer.parseInt(quantityField.getText().trim());
            int color = Integer.parseInt(Objects.requireNonNull(colorsDropdown.getSelectedItem()).toString());
            String paperType = Objects.requireNonNull(paperTypeDropdown.getSelectedItem()).toString();
            String paperSize = Objects.requireNonNull(paperSizeDropdown.getSelectedItem()).toString();
            String sidesStr = Objects.requireNonNull(sidesDropdown.getSelectedItem()).toString();
            String machine = Objects.requireNonNull(machineDropdown.getSelectedItem()).toString();
            
            if (pages <= 0 || qty <= 0 || color <= 0) {
                 JOptionPane.showMessageDialog(this, "Pages, Quantity, and Colors must be positive whole numbers.", "Input Error", JOptionPane.ERROR_MESSAGE);
                 return;
            }

            // 2. Lookup variables and determine Rim Cost
            int rimCost;
            if (PAPER_CATALOGUE.containsKey(paperType)) {
                rimCost = PAPER_CATALOGUE.get(paperType);
            } else if (paperType.equals("Others")) {
                if (paperCostField.getText().trim().isEmpty()) {
                     throw new IllegalArgumentException("Please enter the custom Rim Cost for 'Others'.");
                }
                rimCost = Integer.parseInt(paperCostField.getText().trim());
            } else {
                throw new IllegalArgumentException("Invalid paper type selected.");
            }
            
            Integer printed = SIDES_VALUES.get(sidesStr);
            Integer divisible = PAPER_SIZES.get(paperSize);
            Integer perRun = MACHINES.get(machine);

            // --- 3A. Core Printing Calculation Logic ---
            
            double A3Sheets = (double) qty / divisible;
            double A3EquivalentPages = (double) pages / divisible; 

            // PLATES Cost
            int plates = (int) Math.ceil(A3EquivalentPages) * color;
            double plateCost = (double) plates * PLATE_COST_PER_UNIT;

            // RUNS Cost
            double runcal = Math.ceil(A3Sheets / 1000.0) * color * Math.ceil(A3EquivalentPages);
            double runs = (pages == 1) ? runcal * printed : runcal;
            double runCost = runs * perRun;
            
            // MATERIAL Cost (RIMS)
            double rimsNeeded = (pages > 1) 
                ? ((A3Sheets / 500.0) / printed) * pages 
                : A3Sheets / 500.0;

            double rimsCharged = (rimsNeeded < 1.0) ? 1.0 : rimsNeeded; 
            double materialCost = rimsCharged * rimCost;

            // Calculate Core Production Total
            double totalProductionCost = plateCost + runCost + materialCost;


            // --- 3B. Optional Finishing & Profit Costs Calculation ---
            
            // Overall Fixed Costs (Cutting, Packaging, Other)
            double cuttingCost = getOptionalDouble(cuttingCostField);
            double packagingCost = getOptionalDouble(packagingCostField);
            double otherOverallCost = getOptionalDouble(otherOverallCostField);
            double overallFixedCost = cuttingCost + packagingCost + otherOverallCost;

            // Unit Costs (Collection, Binding, Lamination, Cover, Other, Profit)
            double collectionUnitCost = getOptionalDouble(collectionCostField);
            double bindingUnitCost = getOptionalDouble(bindingCostField);
            double laminationUnitCost = getOptionalDouble(laminationCostField);
            double coverUnitCost = getOptionalDouble(coverCostField);
            double otherUnitCost = getOptionalDouble(otherUnitCostField);
            double profitMarginUnitCost = getOptionalDouble(profitMarginUnitCostField);

            // Total Unit Cost for finishing (excluding profit)
            double totalFinishingUnitCost = collectionUnitCost + bindingUnitCost + laminationUnitCost + coverUnitCost + otherUnitCost;
            
            // Total cost of variable finishing
            double totalVariableFinishingCost = totalFinishingUnitCost * qty;
            
            // Total Profit
            double totalProfit = profitMarginUnitCost * qty;
            
            // Total FINISHING & PROFIT Cost
            double totalFinishingAndProfit = overallFixedCost + totalVariableFinishingCost + totalProfit;

            // 4. Total Cost
            double totalCost = totalProductionCost + totalFinishingAndProfit;
            double unitCost = qty > 0 ? totalCost / qty : 0;

            // 5. Display output
            String message = String.format(
                "--- INPUTS ---\n" +
                "Pages: %d\t\t\t\t Quantity: %d\n" +
                "Paper Type: %s (Kshs. %s/Rim)\n" +
                "Size/Colors: %s / %d Colors\n\n" +
                
                "--- CORE PRODUCTION BREAKDOWN ---\n" +
                "Plates Count: %d\t\t\t Plate Cost (@%s/Plate): Kshs. %s\n" +
                "Machine Runs: %s\t\t\t Runs Cost (@%s/Run): Kshs. %s\n" +
                "Rims Charged: %s\t\t\t Material Cost: Kshs. %s\n" +
                "-> CORE TOTAL: Kshs. %s\n\n" +
                
                "--- FINISHING & PROFIT BREAKDOWN ---\n" +
                "Total Overall Fixed Costs: Kshs. %s\n" +
                "Variable Fin. Cost Per Copy (Excl. Profit): Kshs. %s\n" +
                "Total Variable Fin. Cost: Kshs. %s\n" +
                "Total Profit Margin (Kshs. %s/Unit): Kshs. %s\n\n" +
                
                "--- FINAL QUOTE ---\n" +
                "TOTAL FINAL COST (Incl. Profit): Kshs. %s\n" +
                "UNIT COST (Selling Price per Copy): Kshs. %s",
                
                // INPUTS
                pages, qty,
                paperType, DECIMAL_FORMAT.format(rimCost),
                paperSize, color,
                
                // CORE BREAKDOWN
                plates, DECIMAL_FORMAT.format(PLATE_COST_PER_UNIT), DECIMAL_FORMAT.format(plateCost),
                DECIMAL_FORMAT.format(runs), DECIMAL_FORMAT.format(perRun), DECIMAL_FORMAT.format(runCost),
                DECIMAL_FORMAT.format(rimsCharged), DECIMAL_FORMAT.format(materialCost),
                DECIMAL_FORMAT.format(totalProductionCost),
                
                // FINISHING & PROFIT BREAKDOWN
                DECIMAL_FORMAT.format(overallFixedCost),
                DECIMAL_FORMAT.format(totalFinishingUnitCost),
                DECIMAL_FORMAT.format(totalVariableFinishingCost),
                DECIMAL_FORMAT.format(profitMarginUnitCost), DECIMAL_FORMAT.format(totalProfit),
                
                // FINAL QUOTE
                DECIMAL_FORMAT.format(totalCost), DECIMAL_FORMAT.format(unitCost)
            );
            
            quotationArea.setText(message);
            
            // 6. Save calculation to history
            saveCalculationToHistory(qty, totalCost, message);

        } catch (NumberFormatException ex) {
            JOptionPane.showMessageDialog(this, "Please ensure all cost fields contain valid numbers (or are left empty for 0).", "Input Error", JOptionPane.ERROR_MESSAGE);
        } catch (IllegalArgumentException ex) {
            JOptionPane.showMessageDialog(this, ex.getMessage(), "Input Error", JOptionPane.ERROR_MESSAGE);
        } catch (Exception ex) {
            JOptionPane.showMessageDialog(this, "An unexpected error occurred: " + ex.getMessage(), "Runtime Error", JOptionPane.ERROR_MESSAGE);
            ex.printStackTrace();
        }
    }
    
    /**
     * Saves the current calculation's inputs and results to the history list.
     */
    private void saveCalculationToHistory(int qty, double totalCost, String resultText) {
        Map<String, String> currentInputs = new HashMap<>();

        // Core Printing Inputs
        currentInputs.put("pagesField", pagesField.getText());
        currentInputs.put("quantityField", quantityField.getText());
        currentInputs.put("paperCostField", paperCostField.getText());
        currentInputs.put("paperTypeDropdown", Objects.requireNonNull(paperTypeDropdown.getSelectedItem()).toString());
        currentInputs.put("paperSizeDropdown", Objects.requireNonNull(paperSizeDropdown.getSelectedItem()).toString());
        currentInputs.put("colorsDropdown", Objects.requireNonNull(colorsDropdown.getSelectedItem()).toString());
        currentInputs.put("sidesDropdown", Objects.requireNonNull(sidesDropdown.getSelectedItem()).toString());
        currentInputs.put("machineDropdown", Objects.requireNonNull(machineDropdown.getSelectedItem()).toString());
        
        // Overall Fixed Costs
        currentInputs.put("cuttingCostField", cuttingCostField.getText());
        currentInputs.put("packagingCostField", packagingCostField.getText());
        currentInputs.put("otherOverallCostField", otherOverallCostField.getText());
        
        // Unit Costs
        currentInputs.put("collectionCostField", collectionCostField.getText());
        currentInputs.put("bindingCostField", bindingCostField.getText());
        currentInputs.put("laminationCostField", laminationCostField.getText());
        currentInputs.put("coverCostField", coverCostField.getText());
        currentInputs.put("otherUnitCostField", otherUnitCostField.getText());
        currentInputs.put("profitMarginUnitCostField", profitMarginUnitCostField.getText());
        
        // Result data
        currentInputs.put("quotationArea", resultText);
        currentInputs.put("totalCost", String.valueOf(totalCost)); // Explicitly store total cost
        currentInputs.put("quantity", String.valueOf(qty)); // Explicitly store quantity
        
        // Maintain max size of 5 (newest calculation at index 0)
        calculationHistory.add(0, currentInputs);
        if (calculationHistory.size() > MAX_HISTORY_SIZE) {
            calculationHistory.remove(MAX_HISTORY_SIZE);
        }

        updateHistoryDropdown(); 
    }
    
    /**
     * Updates the JComboBox with summaries of all stored calculations.
     */
    private void updateHistoryDropdown() {
        historyDropdown.removeAllItems();
        
        for (int i = 0; i < calculationHistory.size(); i++) {
            Map<String, String> record = calculationHistory.get(i);
            
            double savedTotalCost = Double.parseDouble(record.getOrDefault("totalCost", "0.0"));
            int savedQty = Integer.parseInt(record.getOrDefault("quantity", "0"));

            // Note: History is 1-indexed for display, but 0-indexed internally (newest is #1)
            String summary = String.format("Quote #%d | Qty: %d | Total: Kshs. %s", 
                                           i + 1, savedQty, DECIMAL_FORMAT.format(savedTotalCost));
            historyDropdown.addItem(summary);
        }
        
        historyDropdown.setSelectedIndex(0);
        historyDropdown.setEnabled(true);
        loadHistoryButton.setEnabled(true);
    }
    
    /**
     * Loads the selected calculation from the history into the main UI fields.
     */
    private void loadCalculation() {
        int selectedIndex = historyDropdown.getSelectedIndex();
        if (selectedIndex < 0 || selectedIndex >= calculationHistory.size()) {
            return;
        }

        Map<String, String> record = calculationHistory.get(selectedIndex);

        // Load Core Printing Inputs
        pagesField.setText(record.getOrDefault("pagesField", ""));
        quantityField.setText(record.getOrDefault("quantityField", ""));
        paperCostField.setText(record.getOrDefault("paperCostField", ""));
        
        // Load Dropdowns
        paperTypeDropdown.setSelectedItem(record.getOrDefault("paperTypeDropdown", "Bond 70"));
        paperSizeDropdown.setSelectedItem(record.getOrDefault("paperSizeDropdown", "A3"));
        colorsDropdown.setSelectedItem(record.getOrDefault("colorsDropdown", "1"));
        sidesDropdown.setSelectedItem(record.getOrDefault("sidesDropdown", "Single sided"));
        machineDropdown.setSelectedItem(record.getOrDefault("machineDropdown", "GTO 46"));
        
        // Trigger the custom paper field toggle based on the loaded type
        togglePaperCostField(); 
        
        // Load Overall Fixed Costs
        cuttingCostField.setText(record.getOrDefault("cuttingCostField", ""));
        packagingCostField.setText(record.getOrDefault("packagingCostField", ""));
        otherOverallCostField.setText(record.getOrDefault("otherOverallCostField", ""));
        
        // Load Unit Costs
        collectionCostField.setText(record.getOrDefault("collectionCostField", ""));
        bindingCostField.setText(record.getOrDefault("bindingCostField", ""));
        laminationCostField.setText(record.getOrDefault("laminationCostField", ""));
        coverCostField.setText(record.getOrDefault("coverCostField", ""));
        otherUnitCostField.setText(record.getOrDefault("otherUnitCostField", ""));
        profitMarginUnitCostField.setText(record.getOrDefault("profitMarginUnitCostField", ""));

        // Load Result
        quotationArea.setText(record.getOrDefault("quotationArea", ""));
    }
}